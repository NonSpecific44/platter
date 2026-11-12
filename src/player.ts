// Playback engine: owns the queue and drives the mpv backend.
//
// mpv only ever knows about the current track and the one after it. Every URL
// we hand to mpv carries a unique `_n` marker, so when mpv reports a new
// `path` we can tell a gapless advance (path === nextUrl) apart from anything
// else, even when the same track is queued twice.
import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Track, toTrack } from "./plex";
import { isAndroid } from "./platform";
import { similarTracks } from "./similar";
import { localMatch } from "./local";
import { connectionKind, ensureConnection } from "./connection";
import { EQ_BANDS, fmtTime, isExcluded, loadJson, persist, sectionKey, server, toast, useSession, useSettings } from "./store";

export interface QItem {
  uid: string;
  track: Track;
}

type Repeat = "off" | "all" | "one";
type Sleep = { until: number; minutes: number } | { endOfTrack: true } | null;

interface PlayerState {
  queue: QItem[];
  original: QItem[] | null;
  index: number;
  shuffle: boolean;
  repeat: Repeat;
  stopAfter: boolean;
  position: number;
  duration: number;
  paused: boolean;
  buffering: boolean;
  loaded: boolean;
  volume: number;
  muted: boolean;
  sleep: Sleep;
  history: Track[];
}

const saved = loadJson<Partial<PlayerState>>("tonearm.queue", {});
const savedPos = loadJson<{ position?: number; volume?: number; muted?: boolean; repeat?: Repeat; shuffle?: boolean }>(
  "tonearm.playback",
  {},
);

export const usePlayer = create<PlayerState>(() => ({
  queue: saved.queue ?? [],
  original: saved.original ?? null,
  index: Math.min(saved.index ?? 0, Math.max(0, (saved.queue?.length ?? 1) - 1)),
  shuffle: savedPos.shuffle ?? false,
  repeat: savedPos.repeat ?? "off",
  stopAfter: false,
  position: savedPos.position ?? 0,
  duration: (saved.queue?.[saved.index ?? 0]?.track.duration ?? 0) / 1000,
  paused: true,
  buffering: false,
  loaded: false,
  volume: savedPos.volume ?? 80,
  muted: savedPos.muted ?? false,
  sleep: null,
  history: saved.history ?? [],
}));

// The queue can be large; only write it when it actually changes.
let lastQueueRef: unknown;
let lastHistRef: unknown;
let lastIndex = -1;
usePlayer.subscribe((s) => {
  if (s.queue === lastQueueRef && s.history === lastHistRef && s.index === lastIndex) return;
  lastQueueRef = s.queue;
  lastHistRef = s.history;
  lastIndex = s.index;
  try {
    localStorage.setItem("tonearm.queue", JSON.stringify({ queue: s.queue, original: s.original, index: s.index, history: s.history }));
  } catch {
    /* quota */
  }
});
persist("tonearm.playback", usePlayer, (s) => ({
  position: s.position,
  volume: s.volume,
  muted: s.muted,
  repeat: s.repeat,
  shuffle: s.shuffle,
}), 2000);

const get = usePlayer.getState;
const set = usePlayer.setState;

export const currentTrack = (): Track | undefined => get().queue[get().index]?.track;

// ---- internals -------------------------------------------------------------

let urlSeq = 0;
let currentUrl: string | null = null;
let nextUrl: string | null = null;
let nextUid: string | null = null;
let expectingPlayback = false;
let scrobbled = false;
let lastTimeline = 0;
let sleepBaseVolume: number | null = null;
const session = crypto.randomUUID();

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const items = (tracks: Track[]): QItem[] => tracks.map((track) => ({ uid: uid(), track }));

/** Tracks that wouldn't play as they are, so stream a copy converted by Plex instead. */
const converted = new Set<string>();

function wantsTranscode(t: Track) {
  const s = useSettings.getState();
  if (s.transcode === "always") return s.transcodeKbps;
  const info = useSession.getState().server;
  if (s.transcode === "remote" && !info?.local) return s.transcodeKbps;
  if (converted.has(t.ratingKey)) return 320;
  // Plex's relay carries about 2 Mbps; hi-res files stall on it, so they're converted, as Plexamp does.
  if (info && connectionKind(info) === "Plex relay" && (t.bitrate ?? 0) > 1800) return 320;
  return null;
}

/** A file on this device beats streaming the same song. */
function urlFor(t: Track) {
  const file = localMatch(t)?.local;
  if (file) return isAndroid() ? "file://" + file.split("/").map(encodeURIComponent).join("/") : file;
  const u = new URL(server().streamUrl(t, wantsTranscode(t), session));
  u.searchParams.set("_n", String(++urlSeq));
  return u.toString();
}

/** Index that should play after the current one when the track ends naturally. */
function upcomingIndex(opts: { manual?: boolean } = {}): number | null {
  const { queue, index, repeat, stopAfter } = get();
  if (!queue.length) return null;
  if (!opts.manual && stopAfter) return null;
  if (index + 1 < queue.length) return index + 1;
  if (repeat === "all" || (opts.manual && repeat === "one")) return 0;
  return null;
}

async function call(cmd: string, args: Record<string, unknown> = {}) {
  try {
    return await invoke(cmd, args);
  } catch (e) {
    console.error(cmd, e);
    toast(`Playback error: ${e}`, { error: true });
  }
}

const setProp = (name: string, value: string | number | boolean) =>
  invoke("player_set", { name, value: typeof value === "boolean" ? (value ? "yes" : "no") : String(value) }).catch((e) =>
    console.warn(`mpv ${name}`, e),
  );

async function syncNext() {
  if (!get().loaded) return;
  const ni = upcomingIndex();
  const item = ni === null ? null : get().queue[ni];
  if (item && item.uid === nextUid && nextUrl) return;
  if (!item && nextUrl === null) return;
  nextUid = item?.uid ?? null;
  nextUrl = item ? urlFor(item.track) : null;
  await call("player_set_next", { next: nextUrl });
}

/** Long tracks (mixes, live sets, audiobooks) pick up where any Plex player left them. */
function resumePoint(t: Track) {
  const off = t.viewOffset ?? 0;
  return t.duration > 10 * 60_000 && off > 30_000 && off < t.duration - 30_000 ? off / 1000 : 0;
}

async function load(index: number, start = 0, paused = false) {
  const item = get().queue[index];
  if (!item) return;
  if (!start) start = resumePoint(item.track);
  fadeOut = null;
  reportStopped();
  set({ index, position: start, duration: item.track.duration / 1000, loaded: true, paused });
  currentUrl = urlFor(item.track);
  const ni = upcomingIndex();
  const nItem = ni === null ? null : get().queue[ni];
  nextUid = nItem?.uid ?? null;
  nextUrl = nItem ? urlFor(nItem.track) : null;
  expectingPlayback = true;
  await setProp("loop-file", get().repeat === "one" ? "inf" : "no");
  await call("player_load", { url: currentUrl, next: nextUrl, start, paused });
  trackStarted();
}

const LAST_PLAYED = "tonearm.lastPlayedAt";

/** Artwork for notifications and media controls, which can't read the app's own asset URLs. */
function coverForSystem(t: Track) {
  const thumb = localMatch(t)?.thumb ?? t.thumb;
  if (thumb?.startsWith("local-cover:")) return "file://" + thumb.slice(12);
  return server().imageUrl(thumb, 512) ?? null;
}

function trackStarted() {
  const t = currentTrack();
  if (!t) return;
  localStorage.setItem(LAST_PLAYED, String(Date.now()));
  scrobbled = false;
  lastTimeline = 0;
  const s = useSettings.getState();
  invoke("media_track", {
    meta: {
      key: t.albumKey ?? t.ratingKey,
      title: t.title,
      artist: t.artist,
      album: t.album,
      duration: t.duration / 1000,
      coverUrl: coverForSystem(t),
      notify: s.notifications && !document.hasFocus(),
    },
  }).catch(() => undefined);
  set((st) => ({ history: [t, ...st.history.filter((h) => h.ratingKey !== t.ratingKey)].slice(0, 200) }));
  if (s.reportToPlex) server().timeline(t, get().paused ? "paused" : "playing", get().position * 1000, session);
  void maybeAutoplay();
  void applyGain(t);
  preloadGain();
}

// ---- crossfade ----------------------------------------------------------------------------

/** The uid of the track fading out, so a fade only starts once per track. */
let fadeOut: string | null = null;
let fadeStarting = false;

function maybeCrossfade(b: BackendState) {
  const s = useSettings.getState();
  if (!s.crossfade || s.bitPerfect || b.paused || b.idle || b.buffering || !b.duration) return;
  const { queue, index, repeat } = get();
  const cur = queue[index];
  if (!cur || fadeOut === cur.uid || repeat === "one") return;
  const remaining = b.duration - b.position;
  if (remaining > s.crossfadeSeconds || remaining <= 0.3 || b.duration < s.crossfadeSeconds * 2) return;
  const ni = upcomingIndex();
  const nextItem = ni === null ? null : queue[ni];
  if (!nextItem) return;
  // Albums were sequenced to run into each other; leave those gapless.
  if (s.crossfadeSkipAlbums && cur.track.albumKey && cur.track.albumKey === nextItem.track.albumKey) return;
  fadeOut = cur.uid;
  reportStopped();
  const url = nextItem.uid === nextUid && nextUrl ? nextUrl : urlFor(nextItem.track);
  currentUrl = url;
  nextUrl = null;
  nextUid = null;
  expectingPlayback = true;
  set({ index: ni!, position: 0, duration: nextItem.track.duration / 1000 });
  fadeStarting = true;
  void call("player_crossfade", { url, next: null, seconds: Math.min(s.crossfadeSeconds, remaining) }).then(() => {
    // Reports from the outgoing track may still be on their way; give them a moment to land.
    setTimeout(() => (fadeStarting = false), 400);
    set({ position: 0 });
    trackStarted();
    void syncNext();
  });
}

// ---- loudness ----------------------------------------------------------------------------

const gainCache = new Map<string, { track?: number; album?: number } | null>();

/** Plex's loudness analysis for a track, if the server has done it. */
async function plexGain(t: Track) {
  if (t.local) return { track: t.gain, album: t.albumGain };
  if (gainCache.has(t.ratingKey)) return gainCache.get(t.ratingKey);
  let g: { track?: number; album?: number } | null = null;
  try {
    const audio = (await server().trackStreams(t.ratingKey)).find((x) => x.streamType === 2);
    const track = parseFloat(audio?.gain);
    const album = parseFloat(audio?.albumGain);
    if (Number.isFinite(track) || Number.isFinite(album)) {
      g = { track: Number.isFinite(track) ? track : undefined, album: Number.isFinite(album) ? album : undefined };
    }
  } catch {
    return null; // don't cache a network failure
  }
  gainCache.set(t.ratingKey, g);
  return g;
}

/**
 * Evens out volume between tracks using Plex's analysis (or a local file's tags), which works
 * for every file once Plex has analysed it. Falls back to ReplayGain tags in the stream.
 */
async function applyGain(t: Track) {
  const s = useSettings.getState();
  const mode = s.replaygain;
  if (mode === "no" || mode === "dynamic" || s.bitPerfect) {
    void setProp("volume-gain", 0);
    return;
  }
  const g = await plexGain(t);
  if (currentTrack()?.ratingKey !== t.ratingKey) return;
  const db = mode === "album" ? g?.album ?? g?.track : g?.track ?? g?.album;
  if (db === undefined) {
    void setProp("replaygain", mode);
    void setProp("volume-gain", 0);
  } else {
    void setProp("replaygain", "no");
    void setProp("volume-gain", Math.max(-30, Math.min(12, db + s.replaygainPreamp)));
  }
}

/** Fetch the next track's gain ahead of time so it applies as the track starts. */
function preloadGain() {
  const ni = upcomingIndex();
  const t = ni === null ? null : get().queue[ni]?.track;
  if (t && useSettings.getState().replaygain !== "no") void plexGain(t);
}

let autoplayBusy = false;
let autoplayAnnounced = false;

/**
 * Autoplay: once the last track in the queue starts, append similar music so playback carries
 * on (gaplessly, since the next track is queued in the backend straight away).
 */
async function maybeAutoplay() {
  const s = get();
  if (!useSettings.getState().autoplay || autoplayBusy || playerFlags.remote) return;
  if (!s.queue.length || s.index < s.queue.length - 1 || s.repeat !== "off" || s.stopAfter) return;
  autoplayBusy = true;
  try {
    const seeds = s.queue.slice(-5).map((q) => q.track);
    const exclude = new Set([...s.queue.map((q) => q.track.ratingKey), ...s.history.slice(0, 150).map((t) => t.ratingKey)]);
    const tracks = await similarTracks(seeds, exclude, 25);
    // Give up if the queue changed while we were looking.
    if (!tracks.length || get().queue.length !== s.queue.length || get().index !== s.index) return;
    const added = items(tracks);
    set((st) => ({ queue: [...st.queue, ...added], original: st.original ? [...st.original, ...added] : null }));
    if (!autoplayAnnounced) {
      autoplayAnnounced = true;
      toast("Autoplay: queued similar music", { action: { label: "Turn off", run: () => useSettings.getState().set({ autoplay: false }) } });
    }
    await syncNext();
  } finally {
    autoplayBusy = false;
  }
}

/**
 * If something was played on another Plex player more recently than here, offer to carry on
 * from where it stopped.
 */
export async function offerHandoff() {
  if (!useSettings.getState().reportToPlex || (get().loaded && !get().paused)) return;
  const t = await server()
    .lastPlayed(sectionKey())
    .catch(() => null);
  if (!t?.lastViewedAt || currentTrack()?.ratingKey === t.ratingKey) return;
  if (t.lastViewedAt * 1000 <= Number(localStorage.getItem(LAST_PLAYED) ?? 0) + 60_000) return;
  const at = (t.viewOffset ?? 0) / 1000;
  toast(`Continue “${t.title}” by ${t.artist} from another device?`, {
    action: { label: at > 5 ? `Resume at ${fmtTime(at)}` : "Play", run: () => player.playTracks([t], 0, { at }) },
  });
}

function reportStopped() {
  const t = currentTrack();
  if (t && get().loaded && useSettings.getState().reportToPlex) server().timeline(t, "stopped", get().position * 1000, session);
}

/** While controlling another device, local backend events must not touch the mirrored state. */
export const playerFlags = { remote: false };

// ---- events from the backend -----------------------------------------------

interface BackendState {
  position: number;
  duration: number;
  paused: boolean;
  idle: boolean;
  volume: number;
  muted: boolean;
  buffering: boolean;
}

function onState(b: BackendState) {
  // While a crossfade starts, reports may still describe the outgoing track.
  if (playerFlags.remote || fadeStarting) return;
  const prev = get();
  maybeCrossfade(b);
  if (b.idle && !prev.loaded) return; // initial idle before anything was loaded
  const patch: Partial<PlayerState> = { buffering: b.buffering, muted: b.muted };
  if (!b.idle) {
    patch.position = b.position;
    if (b.duration > 0) patch.duration = b.duration;
    patch.paused = b.paused;
  }
  if (sleepBaseVolume === null) patch.volume = b.volume;
  set(patch);

  const t = currentTrack();
  if (!t) return;
  if (prev.paused !== b.paused && !b.idle) {
    invoke("media_playback", { state: b.paused ? "paused" : "playing", position: b.position }).catch(() => undefined);
    if (useSettings.getState().reportToPlex) server().timeline(t, b.paused ? "paused" : "playing", b.position * 1000, session);
  }
  const now = Date.now();
  if (!b.paused && !b.idle) {
    if (useSettings.getState().reportToPlex && now - lastTimeline > 10000) {
      lastTimeline = now;
      server().timeline(t, "playing", b.position * 1000, session);
    }
    if (!scrobbled && b.duration > 30 && b.position / b.duration > 0.9) {
      scrobbled = true;
      if (useSettings.getState().reportToPlex) server().scrobble(t.ratingKey);
    }
  }
  tickSleep();
}

/** Android Auto started a queue natively: the app adopts it and carries on from the same point. */
function takeOverQueue(raw: unknown, play = false) {
  if (!raw) return;
  const q = (typeof raw === "string" ? JSON.parse(raw) : raw) as { tracks: any[]; index: number; position: number; paused: boolean };
  if (!q.tracks?.length) return;
  const tracks = q.tracks.map(toTrack);
  set({ queue: items(tracks), original: null, index: q.index, shuffle: false, stopAfter: false });
  void load(q.index, q.position, play ? false : q.paused);
}

let lastRecovery = 0;

/**
 * A failed stream usually means the network changed: find a working address for the server and
 * carry on from the same point. Only reports an error if that doesn't help.
 */
async function onPlaybackError(msg: string) {
  const t = currentTrack();
  const { position, paused, index, loaded } = get();
  console.warn("playback error", msg, t?.ratingKey);
  if (loaded && t && !localMatch(t)) {
    if (Date.now() - lastRecovery > 20_000) {
      lastRecovery = Date.now();
      await ensureConnection();
      return load(index, position, paused);
    }
    // Still failing on a good connection: this file is the problem. Plex can convert it.
    if (!converted.has(t.ratingKey) && wantsTranscode(t) === null) {
      converted.add(t.ratingKey);
      toast(`Couldn't play “${t.title}” as it is, so playing a converted copy`);
      return load(index, position, paused);
    }
  }
  toast(`${msg}${t ? `: ${t.title}` : ""}`, { error: true });
  // Carry on with the rest rather than stopping.
  if (t && index < get().queue.length - 1) void player.next();
}

function onFile(path: string) {
  if (playerFlags.remote || path === currentUrl) return;
  if (path === nextUrl) {
    const ni = upcomingIndex();
    reportStopped();
    currentUrl = nextUrl;
    nextUrl = null;
    nextUid = null;
    set({ index: ni ?? 0, position: 0 });
    trackStarted();
    void syncNext();
  }
}

function onIdle() {
  if (playerFlags.remote || !expectingPlayback) return;
  expectingPlayback = false;
  reportStopped();
  const { stopAfter, sleep } = get();
  if (stopAfter || (sleep && "endOfTrack" in sleep)) {
    if (sleep) toast("Sleep timer: playback stopped");
    set({ stopAfter: false, sleep: null });
    const ni = upcomingIndex();
    if (ni !== null) {
      set({ index: ni, position: 0, paused: true, loaded: false });
      return;
    }
  }
  set({ paused: true, position: 0, loaded: false });
  currentUrl = nextUrl = nextUid = null;
  invoke("media_playback", { state: "stopped", position: 0 }).catch(() => undefined);
}

function tickSleep() {
  const { sleep, volume } = get();
  if (!sleep || !("until" in sleep)) return;
  const left = sleep.until - Date.now();
  const fade = 15000;
  if (left <= 0) {
    const base = sleepBaseVolume ?? volume;
    sleepBaseVolume = null;
    set({ sleep: null });
    void setProp("pause", true).then(() => setProp("volume", base));
    toast("Sleep timer: playback paused");
  } else if (left < fade) {
    if (sleepBaseVolume === null) sleepBaseVolume = volume;
    void setProp("volume", Math.round(sleepBaseVolume * (left / fade)));
  }
}

// ---- public controls -------------------------------------------------------

export const player = {
  async toggle() {
    if (!get().queue.length) return;
    if (!get().loaded) return load(get().index, get().position);
    return setProp("pause", !get().paused);
  },
  async play() {
    if (!get().loaded) return player.toggle();
    return setProp("pause", false);
  },
  async pause() {
    if (get().loaded) return setProp("pause", true);
  },
  async stop() {
    reportStopped();
    expectingPlayback = false;
    set({ loaded: false, paused: true, position: 0 });
    currentUrl = nextUrl = nextUid = null;
    await call("player_stop");
    invoke("media_playback", { state: "stopped", position: 0 }).catch(() => undefined);
  },
  async next() {
    const ni = upcomingIndex({ manual: true });
    if (ni === null) return player.stop();
    return load(ni, 0, get().loaded ? get().paused : false);
  },
  async previous() {
    const { position, index, queue, repeat, loaded, paused } = get();
    if (loaded && position > 3) return player.seek(0);
    const pi = index > 0 ? index - 1 : repeat === "all" ? queue.length - 1 : 0;
    return load(pi, 0, loaded ? paused : false);
  },
  async seek(seconds: number) {
    const s = Math.max(0, Math.min(seconds, get().duration || seconds));
    set({ position: s });
    if (!get().loaded) return;
    await call("player_seek", { seconds: s });
    invoke("media_playback", { state: get().paused ? "paused" : "playing", position: s }).catch(() => undefined);
  },
  seekBy: (d: number) => player.seek(get().position + d),
  async setVolume(v: number) {
    v = Math.round(Math.max(0, Math.min(100, v)));
    sleepBaseVolume = null;
    set({ volume: v });
    await setProp("volume", v);
    invoke("media_volume", { volume: v / 100 }).catch(() => undefined);
  },
  toggleMute: () => setProp("mute", !get().muted),
  jump: (i: number) => load(i),

  playTracks(tracks: Track[], start = 0, opts: { shuffle?: boolean; at?: number } = {}) {
    if (!tracks.length) return;
    let q = items(tracks);
    const shuffle = opts.shuffle ?? get().shuffle;
    let index = Math.max(0, Math.min(start, q.length - 1));
    let original: QItem[] | null = null;
    if (shuffle) {
      original = q;
      // "Shuffle" buttons shuffle everything; picking a track keeps it first.
      const first = opts.shuffle === true && start === 0 ? null : q[index];
      const rest = smartShuffle(first ? q.filter((x) => x !== first) : q);
      q = first ? [first, ...rest] : rest;
      index = 0;
    }
    set({ queue: q, original, index, shuffle, stopAfter: false });
    return load(index, opts.at ?? 0);
  },
  playNext(tracks: Track[]) {
    if (!tracks.length) return;
    if (!get().queue.length) return player.playTracks(tracks);
    const add = items(tracks);
    set((s) => ({
      queue: [...s.queue.slice(0, s.index + 1), ...add, ...s.queue.slice(s.index + 1)],
      original: s.original ? [...s.original, ...add] : null,
    }));
    toast(tracks.length === 1 ? `“${tracks[0].title}” will play next` : `${tracks.length} tracks will play next`);
    void syncNext();
  },
  addToQueue(tracks: Track[]) {
    if (!tracks.length) return;
    if (!get().queue.length) {
      const add = items(tracks);
      set({ queue: add, index: 0, original: null, position: 0, loaded: false });
      toast(`Added ${tracks.length} track${tracks.length > 1 ? "s" : ""} to the queue`);
      return;
    }
    const add = items(tracks);
    set((s) => ({ queue: [...s.queue, ...add], original: s.original ? [...s.original, ...add] : null }));
    toast(tracks.length === 1 ? `Added “${tracks[0].title}” to the queue` : `Added ${tracks.length} tracks to the queue`);
    void syncNext();
  },
  removeAt(i: number) {
    const before = { queue: get().queue, index: get().index, original: get().original };
    const removed = before.queue[i];
    if (!removed) return;
    if (i === before.index) {
      // Removing the playing track: move on to whatever follows.
      const q = before.queue.filter((_, j) => j !== i);
      set({ queue: q, original: before.original?.filter((x) => x.uid !== removed.uid) ?? null });
      if (q.length === 0) void player.stop();
      else if (get().loaded) void load(Math.min(i, q.length - 1), 0, get().paused);
      else set({ index: Math.min(i, q.length - 1), position: 0 });
    } else {
      set({
        queue: before.queue.filter((_, j) => j !== i),
        index: i < before.index ? before.index - 1 : before.index,
        original: before.original?.filter((x) => x.uid !== removed.uid) ?? null,
      });
      void syncNext();
    }
    toast(`Removed “${removed.track.title}”`, {
      action: {
        label: "Undo",
        run: () => {
          if (i === before.index) return;
          const cur = get().queue[get().index];
          const q = [...get().queue];
          q.splice(Math.min(i, q.length), 0, removed);
          set({ queue: q, index: q.findIndex((x) => x.uid === cur?.uid), original: before.original });
          void syncNext();
        },
      },
    });
  },
  move(from: number, to: number) {
    if (from === to) return;
    const q = [...get().queue];
    const cur = q[get().index];
    const [m] = q.splice(from, 1);
    q.splice(to, 0, m);
    set({ queue: q, index: q.findIndex((x) => x.uid === cur?.uid) });
    void syncNext();
  },
  clearUpcoming() {
    const before = { queue: get().queue, original: get().original };
    set((s) => ({ queue: s.queue.slice(0, s.index + 1), original: null }));
    void syncNext();
    toast("Cleared upcoming tracks", {
      action: { label: "Undo", run: () => (set({ queue: before.queue, original: before.original }), void syncNext()) },
    });
  },
  clearAll() {
    const before = { queue: get().queue, index: get().index, original: get().original };
    void player.stop();
    set({ queue: [], index: 0, original: null });
    toast("Cleared the queue", {
      action: { label: "Undo", run: () => set({ ...before, position: 0, loaded: false }) },
    });
  },
  setShuffle(on: boolean) {
    const { queue, index, original } = get();
    const cur = queue[index];
    if (on) {
      const rest = smartShuffle(queue.filter((_, i) => i !== index));
      set({ shuffle: true, original: queue, queue: cur ? [cur, ...rest] : rest, index: 0 });
    } else {
      const base = original ?? queue;
      const known = new Set(base.map((x) => x.uid));
      const restored = [...base.filter((x) => queue.some((q) => q.uid === x.uid)), ...queue.filter((x) => !known.has(x.uid))];
      set({ shuffle: false, original: null, queue: restored, index: Math.max(0, restored.findIndex((x) => x.uid === cur?.uid)) });
    }
    void syncNext();
  },
  cycleRepeat() {
    const order: Repeat[] = ["off", "all", "one"];
    const repeat = order[(order.indexOf(get().repeat) + 1) % 3];
    set({ repeat });
    void setProp("loop-file", repeat === "one" ? "inf" : "no");
    void syncNext();
  },
  setStopAfter(stopAfter: boolean) {
    set({ stopAfter });
    void syncNext();
  },
  setSleep(minutes: number | "end" | null) {
    if (sleepBaseVolume !== null) {
      void setProp("volume", sleepBaseVolume);
      sleepBaseVolume = null;
    }
    if (minutes === null) {
      set({ sleep: null, stopAfter: false });
      toast("Sleep timer off");
    } else if (minutes === "end") {
      set({ sleep: { endOfTrack: true }, stopAfter: true });
      toast("Playback will stop after this track");
    } else {
      set({ sleep: { until: Date.now() + minutes * 60000, minutes } });
      toast(`Sleep timer: ${minutes} minutes`);
    }
    void syncNext();
  },
  async shuffleLibrary() {
    const tracks = (await server().randomTracks(sectionKey(), 300)).filter((t) => !isExcluded(t));
    set({ shuffle: false, original: null });
    return player.playTracks(smartShuffle(items(tracks)).map((x) => x.track));
  },
};

/** Shuffle that tries hard not to play the same artist twice in a row. */
export function smartShuffle<T extends QItem>(xs: T[]): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  if (!useSettings.getState().smartShuffle) return a;
  for (let i = 1; i < a.length; i++) {
    if (a[i].track.artist !== a[i - 1].track.artist) continue;
    for (let j = i + 1; j < a.length; j++) {
      if (a[j].track.artist !== a[i - 1].track.artist) {
        [a[i], a[j]] = [a[j], a[i]];
        break;
      }
    }
  }
  return a;
}

// ---- settings → mpv --------------------------------------------------------

function eqFilter() {
  const s = useSettings.getState();
  const parts: string[] = [];
  if (s.eqEnabled) parts.push(`volume=${s.eqPreamp}dB`, ...EQ_BANDS.map((f, i) => `equalizer=f=${f}:t=o:w=1:g=${s.eqGains[i] ?? 0}`));
  // "Dynamic" levels everything live, including files nothing has analysed.
  if (s.replaygain === "dynamic") parts.push("dynaudnorm=f=500:g=31:p=0.95:m=8");
  return parts.length ? `lavfi=[${parts.join(",")}]` : "";
}

function applySettings(s = useSettings.getState(), p?: ReturnType<typeof useSettings.getState>) {
  if (!p || s.gapless !== p.gapless) void setProp("gapless-audio", s.gapless ? "weak" : "no");
  if (!p || s.replaygain !== p.replaygain || s.bitPerfect !== p.bitPerfect) {
    void setProp("replaygain", s.replaygain === "dynamic" ? "no" : s.replaygain);
    const t = currentTrack();
    if (p && t && get().loaded) void applyGain(t);
  }
  if (!p || s.replaygainPreamp !== p.replaygainPreamp) void setProp("replaygain-preamp", s.replaygainPreamp);
  if (!p || s.audioDevice !== p.audioDevice) void setProp("audio-device", s.audioDevice);
  if (!p || s.speed !== p.speed || s.bitPerfect !== p.bitPerfect) void setProp("speed", s.bitPerfect ? 1 : s.speed);
  if (isAndroid() && (!p || s.bitPerfect !== p.bitPerfect)) void setProp("bit-perfect", s.bitPerfect);
  if (!p || s.eqEnabled !== p.eqEnabled || s.eqGains !== p.eqGains || s.eqPreamp !== p.eqPreamp || s.replaygain !== p.replaygain || s.bitPerfect !== p.bitPerfect) {
    void setProp("af", eqFilter());
    // Android applies the bands through the system equaliser instead.
    if (isAndroid()) void setProp("eq", JSON.stringify(s.eqEnabled && !s.bitPerfect ? { preamp: s.eqPreamp, bands: EQ_BANDS.map((hz, i) => [hz, s.eqGains[i] ?? 0]) } : null));
  }
  if (!p || s.closeToTray !== p.closeToTray) invoke("set_close_to_tray", { enabled: s.closeToTray }).catch(() => undefined);
}

export async function audioDevices(): Promise<{ name: string; description: string }[]> {
  try {
    return JSON.parse((await invoke<string>("player_get", { name: "audio-device-list" })) || "[]");
  } catch {
    return [{ name: "auto", description: "Autoselect device" }];
  }
}

// ---- wiring ----------------------------------------------------------------

// Desktop events come from Rust (player://…); the Android plugin calls window.__tonearmNative.
const nativeHandlers: Record<string, (payload: any) => void> = {};
(window as any).__tonearmNative = (event: string, payload: unknown) => nativeHandlers[event]?.(payload);

export function onNative<T>(event: string, cb: (payload: T) => void) {
  nativeHandlers[event] = cb;
}

function onBackend<T>(event: string, cb: (payload: T) => void) {
  if (isAndroid()) nativeHandlers[event] = cb;
  else void listen<T>(`player://${event}`, (e) => cb(e.payload));
}

let initialised = false;
export function initPlayer() {
  if (initialised) return;
  initialised = true;
  useSession.subscribe((st, prev) => {
    if (st.server?.uri === prev.server?.uri || !get().loaded) return;
    // The queued next track still points at the old address.
    nextUid = null;
    void syncNext();
  });
  applySettings();
  useSettings.subscribe((s, p) => applySettings(s, p));
  void setProp("volume", get().volume);
  void setProp("mute", get().muted);

  onBackend<BackendState>("state", onState);
  onBackend<string>("file", onFile);
  onBackend("idle", () => onIdle());
  onBackend<string>("error", (msg) => void onPlaybackError(msg));
  const control = ({ action, value }: { action: string; value?: number }) => {
    switch (action) {
      case "play":
        return player.play();
      case "pause":
        return player.pause();
      case "toggle":
        return player.toggle();
      case "next":
        return player.next();
      case "previous":
        return player.previous();
      case "stop":
        return player.stop();
      case "seek":
        return player.seek(value ?? 0);
      case "seekBy":
        return player.seekBy(value ?? 0);
      case "volume":
        return player.setVolume(value ?? get().volume);
    }
  };
  if (isAndroid()) {
    onBackend("control", control);
    // Someone just picked this in the car, so it should play.
    onBackend<string>("external", (raw) => takeOverQueue(raw, true));
    void invoke<string>("player_take_over").then((raw) => takeOverQueue(raw), () => undefined);
  }
  else listen<{ action: string; value?: number }>("media-control", (e) => control(e.payload));
  window.addEventListener("beforeunload", reportStopped);
}
