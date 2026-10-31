// Remote control between devices.
//
// Receiving: the backend's companion server forwards each HTTP request here (remote://request).
// Plex apps can use the standard Companion endpoints (/resources, /player/timeline/poll,
// /player/playback/*); other Tonearms use /tonearm/state (a long-polled snapshot of the whole
// player) and /tonearm/call (run any queue or transport action), which need a token from the
// same Plex account.
//
// Controlling: picking another device routes every `player` action to it and mirrors its state
// into usePlayer, so the whole UI (player bar, queue, lyrics) follows the remote device.
import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { fetch } from "@tauri-apps/plugin-http";
import { PRODUCT, VERSION, clientId, getUser, plexHeaders, toTrack } from "./plex";
import { currentTrack, player, playerFlags, usePlayer } from "./player";
import { server, toast, useSession, useSettings } from "./store";
import { isAndroid } from "./platform";

export { isAndroid };

export interface Device {
  name: string;
  host: string;
  port: number;
  clientId: string;
  product: string;
  deviceClass: string;
  /** What it's playing, when we could ask. */
  nowPlaying?: { title: string; artist: string; paused: boolean };
}

interface RemoteState {
  devices: Device[];
  scanning: boolean;
  target: Device | null;
}

export const useRemote = create<RemoteState>(() => ({ devices: [], scanning: false, target: null }));

/** Everything a controller needs to mirror this device. */
type Snapshot = Pick<
  ReturnType<typeof usePlayer.getState>,
  "queue" | "index" | "position" | "duration" | "paused" | "loaded" | "buffering" | "volume" | "muted" | "shuffle" | "repeat" | "stopAfter"
> & { version: number };

const ROUTED = [
  "toggle", "play", "pause", "stop", "next", "previous", "seek", "seekBy", "setVolume", "toggleMute", "jump",
  "playTracks", "playNext", "addToQueue", "removeAt", "move", "clearUpcoming", "clearAll", "setShuffle",
  "cycleRepeat", "setStopAfter", "setSleep", "shuffleLibrary",
] as const;
type Routed = (typeof ROUTED)[number];

/** The real local implementations, before routing was installed. */
const local = {} as Record<Routed, (...args: any[]) => any>;

// ---- receiving ----------------------------------------------------------------------

let version = 0;
let lastSig = "";
let lastPos = { pos: 0, at: 0 };
let waiters: (() => void)[] = [];
let commandId = 0;

function signature(s: ReturnType<typeof usePlayer.getState>) {
  return [s.queue.map((q) => q.uid).join(","), s.index, s.paused, s.loaded, s.buffering, s.volume, s.muted, s.shuffle, s.repeat, s.stopAfter, Math.round(s.duration)].join("|");
}

function watchState() {
  usePlayer.subscribe((s) => {
    const sig = signature(s);
    const now = performance.now();
    const expected = lastPos.pos + (s.paused ? 0 : (now - lastPos.at) / 1000);
    const jumped = Math.abs(s.position - expected) > 1.5;
    lastPos = { pos: s.position, at: now };
    if (sig === lastSig && !jumped) return;
    lastSig = sig;
    version++;
    const w = waiters;
    waiters = [];
    w.forEach((f) => f());
  });
}

function waitForChange(since: number, ms: number) {
  if (since !== version) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    waiters.push(() => {
      clearTimeout(t);
      resolve();
    });
  });
}

function snapshot(): Snapshot {
  const s = usePlayer.getState();
  return {
    queue: s.queue,
    index: s.index,
    position: s.position,
    duration: s.duration,
    paused: s.paused,
    loaded: s.loaded,
    buffering: s.buffering,
    volume: s.volume,
    muted: s.muted,
    shuffle: s.shuffle,
    repeat: s.repeat,
    stopAfter: s.stopAfter,
    version,
  };
}

const verified = new Map<string, Promise<boolean>>();

/** True if `token` belongs to the account this device is signed in with. */
function sameAccount(token: string | undefined) {
  const me = useSession.getState().user;
  if (!token || !me) return Promise.resolve(false);
  if (token === useSession.getState().token) return Promise.resolve(true);
  let p = verified.get(token);
  if (!p) {
    p = getUser(token)
      .then((u) => !!u.uuid && u.uuid === me.uuid)
      .catch(() => false);
    verified.set(token, p);
  }
  return p;
}

const esc = (v: unknown) => String(v ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
const attrs = (o: Record<string, unknown>) =>
  Object.entries(o)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}="${esc(v)}"`)
    .join(" ");

function timelineXml() {
  const s = usePlayer.getState();
  const t = currentTrack();
  const info = useSession.getState().server;
  const state = !s.loaded || !t ? "stopped" : s.buffering ? "buffering" : s.paused ? "paused" : "playing";
  let host: URL | null = null;
  try {
    host = info ? new URL(info.uri) : null;
  } catch {
    host = null;
  }
  const music = attrs({
    type: "music",
    state,
    controllable: "playPause,stop,volume,shuffle,repeat,seekTo,skipPrevious,skipNext,stepBack,stepForward",
    ...(t && state !== "stopped"
      ? {
          time: Math.round(s.position * 1000),
          duration: Math.round(s.duration * 1000),
          ratingKey: t.ratingKey,
          key: `/library/metadata/${t.ratingKey}`,
          machineIdentifier: info?.machineId,
          address: host?.hostname,
          port: host?.port || (host?.protocol === "https:" ? 443 : 80),
          protocol: host?.protocol.replace(":", ""),
        }
      : {}),
    volume: s.muted ? 0 : s.volume,
    shuffle: s.shuffle ? 1 : 0,
    repeat: s.repeat === "one" ? 1 : s.repeat === "all" ? 2 : 0,
  });
  return `<?xml version="1.0" encoding="UTF-8"?>
<MediaContainer ${attrs({ commandID: commandId, machineIdentifier: clientId(), location: "fullScreenMusic" })}>
  <Timeline ${music} />
  <Timeline type="video" state="stopped" />
  <Timeline type="photo" state="stopped" />
</MediaContainer>`;
}

const ok = () => ({ status: 200, contentType: "text/xml", body: '<?xml version="1.0" encoding="UTF-8"?><Response code="200" status="OK" />' });

async function playMedia(q: Record<string, string>) {
  const info = useSession.getState().server;
  if (q.machineIdentifier && info && q.machineIdentifier !== info.machineId) {
    toast("Can't play media from a different Plex server", { error: true });
    return;
  }
  const at = Number(q.offset ?? 0) / 1000;
  if (q.containerKey) {
    const c = await server().container(q.containerKey.split("?")[0], { own: 1 });
    const items: any[] = c.Metadata ?? [];
    const tracks = items.map(toTrack);
    const sel = items.findIndex((m) => String(m.playQueueItemID) === String(c.playQueueSelectedItemID));
    const byKey = tracks.findIndex((t) => q.key?.endsWith(`/${t.ratingKey}`));
    return local.playTracks(tracks, sel >= 0 ? sel : Math.max(0, byKey), { at, shuffle: false });
  }
  if (q.key) {
    const m = await server().container(q.key);
    const tracks = (m.Metadata ?? []).map(toTrack);
    return local.playTracks(tracks, 0, { at, shuffle: false });
  }
}

interface IncomingRequest {
  id: number;
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: string;
  from: string;
}

async function route(r: IncomingRequest): Promise<{ status: number; contentType: string; body: string }> {
  const q = r.query;
  if (q.commandID) commandId = Number(q.commandID) || commandId;
  const token = r.headers["x-plex-token"] ?? q["X-Plex-Token"];
  const p = r.path.replace(/\/+$/, "");

  if (p.startsWith("/tonearm/")) {
    if (!(await sameAccount(token))) return { status: 401, contentType: "text/plain", body: "unauthorised" };
    if (p === "/tonearm/state") {
      const since = Number(q.since ?? -1);
      await waitForChange(since, Math.min(Number(q.wait ?? 0), 25) * 1000);
      return { status: 200, contentType: "application/json", body: JSON.stringify(snapshot()) };
    }
    if (p === "/tonearm/call") {
      const { method, args } = JSON.parse(r.body || "{}") as { method: Routed; args: unknown[] };
      if (!ROUTED.includes(method)) return { status: 400, contentType: "text/plain", body: "unknown method" };
      await local[method](...(args ?? []));
      return { status: 200, contentType: "application/json", body: "{}" };
    }
    return { status: 404, contentType: "text/plain", body: "not found" };
  }

  switch (p) {
    case "/resources":
      return {
        status: 200,
        contentType: "text/xml",
        body: `<?xml version="1.0" encoding="UTF-8"?><MediaContainer><Player ${attrs({
          title: deviceName(),
          machineIdentifier: clientId(),
          product: PRODUCT,
          version: VERSION,
          platform: platform(),
          protocol: "plex",
          protocolVersion: 1,
          protocolCapabilities: "timeline,playback,playqueues",
          deviceClass: isAndroid() ? "phone" : "pc",
        })} /></MediaContainer>`,
      };
    case "/player/timeline/poll":
      if (q.wait === "1") await waitForChange(version, 20_000);
      return { status: 200, contentType: "text/xml", body: timelineXml() };
    case "/player/timeline/subscribe":
    case "/player/timeline/unsubscribe":
      return ok();
    case "/player/playback/play":
      await local.play();
      return ok();
    case "/player/playback/pause":
      await local.pause();
      return ok();
    case "/player/playback/playPause":
      await local.toggle();
      return ok();
    case "/player/playback/stop":
      await local.stop();
      return ok();
    case "/player/playback/skipNext":
      await local.next();
      return ok();
    case "/player/playback/skipPrevious":
      await local.previous();
      return ok();
    case "/player/playback/stepForward":
      await local.seekBy(15);
      return ok();
    case "/player/playback/stepBack":
      await local.seekBy(-15);
      return ok();
    case "/player/playback/seekTo":
      await local.seek(Number(q.offset ?? 0) / 1000);
      return ok();
    case "/player/playback/skipTo": {
      const i = usePlayer.getState().queue.findIndex((x) => q.key?.endsWith(`/${x.track.ratingKey}`));
      if (i >= 0) await local.jump(i);
      return ok();
    }
    case "/player/playback/setParameters":
      if (q.volume !== undefined) await local.setVolume(Number(q.volume));
      if (q.shuffle !== undefined) await local.setShuffle(q.shuffle === "1");
      if (q.repeat !== undefined) {
        const want = q.repeat === "1" ? "one" : q.repeat === "2" ? "all" : "off";
        for (let i = 0; i < 3 && usePlayer.getState().repeat !== want; i++) await local.cycleRepeat();
      }
      return ok();
    case "/player/playback/playMedia":
    case "/player/playback/refreshPlayQueue":
      await playMedia(q);
      return ok();
  }
  return { status: 404, contentType: "text/plain", body: "not found" };
}

// ---- identity -------------------------------------------------------------------

function platform() {
  return isAndroid() ? "Android" : "Linux";
}

let hostName = "";

export function deviceName() {
  const custom = useSettings.getState().deviceName.trim();
  if (custom) return custom;
  if (isAndroid()) {
    const model = /Android [^;]*; ([^;)]+?)(?: Build|\))/.exec(navigator.userAgent)?.[1];
    return model ? `Tonearm on ${model}` : "Tonearm on Android";
  }
  return hostName ? `Tonearm on ${hostName}` : "Tonearm";
}

async function announce() {
  const port = await invoke<number>("remote_identity", {
    identity: {
      name: deviceName(),
      clientId: clientId(),
      product: PRODUCT,
      version: VERSION,
      deviceClass: isAndroid() ? "phone" : "pc",
    },
  }).catch(() => 0);
  return port;
}

// ---- controlling ----------------------------------------------------------------------

function base(d: Device) {
  return `http://${d.host.includes(":") ? `[${d.host}]` : d.host}:${d.port}`;
}

async function remoteFetch(d: Device, path: string, init: RequestInit = {}, timeoutMs = 8000) {
  const token = useSession.getState().token;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(base(d) + path, {
      ...init,
      signal: ctl.signal,
      headers: { ...plexHeaders(token), "Content-Type": "application/json", ...(init.headers as Record<string, string>) },
    });
    if (!r.ok) throw new Error(`${d.name} answered ${r.status}`);
    return r;
  } finally {
    clearTimeout(t);
  }
}

async function remoteState(d: Device, since = -1, wait = 0): Promise<Snapshot> {
  const r = await remoteFetch(d, `/tonearm/state?since=${since}&wait=${wait}`, {}, (wait + 8) * 1000);
  return r.json();
}

async function callRemote(method: Routed, args: unknown[]) {
  const d = useRemote.getState().target;
  if (!d) return;
  try {
    await remoteFetch(d, "/tonearm/call", { method: "POST", body: JSON.stringify({ method, args }) }, 15000);
  } catch (e) {
    toast(`Couldn't reach ${d.name}: ${e}`, { error: true });
  }
}

/** Tonearm devices on the network (and ones the Plex server says are playing). */
export async function discover() {
  useRemote.setState({ scanning: true });
  const me = clientId();
  const found = new Map<string, Device>();
  const gdm = await invoke<Device[]>("remote_discover", { ms: 1500 }).catch(() => [] as Device[]);
  for (const d of gdm) if (d.product === PRODUCT && d.clientId !== me) found.set(d.clientId, d);
  // Players the server knows about, in case multicast doesn't get through (Wi-Fi isolation etc.).
  try {
    const c = await server().container("/status/sessions");
    for (const m of c.Metadata ?? []) {
      const pl = m.Player;
      if (pl?.product === PRODUCT && pl.machineIdentifier !== me && !found.has(pl.machineIdentifier) && pl.address) {
        found.set(pl.machineIdentifier, {
          name: pl.title || pl.device || "Tonearm",
          host: pl.address,
          port: 32500,
          clientId: pl.machineIdentifier,
          product: PRODUCT,
          deviceClass: "",
        });
      }
    }
  } catch {
    /* the device list just has fewer entries */
  }
  const devices = await Promise.all(
    [...found.values()].map(async (d) => {
      try {
        const s = await remoteState(d);
        const t = s.loaded ? s.queue[s.index]?.track : undefined;
        return { ...d, nowPlaying: t ? { title: t.title, artist: t.artist, paused: s.paused } : undefined };
      } catch {
        return null;
      }
    }),
  );
  const list = devices.filter((d): d is Device & { nowPlaying: Device["nowPlaying"] } => !!d);
  useRemote.setState({ devices: list, scanning: false });
  return list;
}

let localSnapshot: Partial<ReturnType<typeof usePlayer.getState>> | null = null;
let pollGen = 0;

function mirror(s: Snapshot) {
  usePlayer.setState({
    queue: s.queue,
    index: s.index,
    position: s.position,
    duration: s.duration,
    paused: s.paused,
    loaded: s.loaded,
    buffering: s.buffering,
    volume: s.volume,
    muted: s.muted,
    shuffle: s.shuffle,
    repeat: s.repeat,
    stopAfter: s.stopAfter,
    original: null,
  });
}

async function pollLoop(d: Device, gen: number) {
  let since = -1;
  let failures = 0;
  while (gen === pollGen) {
    try {
      const s = await remoteState(d, since, since < 0 ? 0 : 20);
      if (gen !== pollGen) return;
      failures = 0;
      since = s.version;
      mirror(s);
    } catch {
      if (gen !== pollGen) return;
      if (++failures >= 3) {
        toast(`Lost connection to ${d.name}`, { error: true });
        disconnect();
        return;
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
}

/**
 * Starts controlling `d`. If music is playing here, it moves to `d` and carries on from the
 * same point; otherwise `d` keeps playing whatever it was.
 */
export async function connect(d: Device) {
  const cur = useRemote.getState().target;
  if (cur?.clientId === d.clientId) return;
  if (cur) disconnect();
  const s = usePlayer.getState();
  const playingHere = s.loaded && !s.paused && s.queue.length > 0;
  localSnapshot = { queue: s.queue, original: s.original, index: s.index, position: s.position, shuffle: s.shuffle, repeat: s.repeat, volume: s.volume, muted: s.muted };
  if (playingHere) {
    const tracks = s.queue.map((q) => q.track);
    const at = s.position;
    await local.stop();
    useRemote.setState({ target: d });
    playerFlags.remote = true;
    await callRemote("playTracks", [tracks, s.index, { shuffle: false, at }]);
  } else {
    if (s.loaded) await local.stop();
    useRemote.setState({ target: d });
    playerFlags.remote = true;
  }
  toast(`Controlling ${d.name}`);
  void pollLoop(d, ++pollGen);
}

/** Stops controlling the remote device. With `takeOver`, its music moves here. */
export async function disconnect(takeOver = false) {
  const d = useRemote.getState().target;
  if (!d) return;
  pollGen++;
  let carry: Snapshot | null = null;
  if (takeOver) {
    try {
      carry = await remoteState(d);
      await callRemote("pause", []);
    } catch {
      carry = null;
    }
  }
  useRemote.setState({ target: null });
  playerFlags.remote = false;
  usePlayer.setState({ ...(localSnapshot ?? {}), loaded: false, paused: true, buffering: false });
  localSnapshot = null;
  if (carry && carry.queue.length) {
    await local.playTracks(
      carry.queue.map((q) => q.track),
      carry.index,
      { shuffle: false, at: carry.position },
    );
  }
}

const offered = new Set<string>();

/** If another Tonearm is playing and this one isn't, offer to control it. */
async function lookForPlayback() {
  const s = usePlayer.getState();
  if (useRemote.getState().target || (s.loaded && !s.paused)) return;
  const devices = await discover().catch(() => []);
  for (const d of devices) {
    if (d.nowPlaying && !d.nowPlaying.paused && !offered.has(d.clientId)) {
      offered.add(d.clientId);
      toast(`“${d.nowPlaying.title}” is playing on ${d.name}`, { action: { label: "Control it", run: () => connect(d) } });
      return;
    }
  }
}

// ---- setup --------------------------------------------------------------------------------

export async function initRemote() {
  for (const m of ROUTED) {
    const orig = (player as any)[m] as (...a: any[]) => any;
    local[m] = orig;
    (player as any)[m] = (...args: any[]) => (useRemote.getState().target ? callRemote(m, args) : orig(...args));
  }
  watchState();
  hostName = await invoke<string>("remote_hostname").catch(() => "");
  await listen<IncomingRequest>("remote://request", async (e) => {
    const r = e.payload;
    let reply;
    try {
      reply = await route(r);
    } catch (err) {
      reply = { status: 500, contentType: "text/plain", body: String(err) };
    }
    void invoke("remote_reply", { reply: { id: r.id, ...reply } });
  });
  await announce();
  useSettings.subscribe((s, p) => s.deviceName !== p.deviceName && void announce());
  setTimeout(() => void lookForPlayback(), 3000);
  setInterval(() => void lookForPlayback(), 90_000);
}
