// Remote control between devices.
//
// Receiving: the backend's companion server forwards each HTTP request here (remote://request).
// Plex apps can use the standard Companion endpoints (/resources, /player/timeline/poll,
// /player/playback/*); other Platters use /tonearm/state (a long-polled snapshot of the whole
// player) and /tonearm/call (run any queue or transport action), which need a token from the
// same Plex account.
//
// Syncing (Platter to Platter): every few seconds each device POSTs its state to the others'
// /tonearm/sync and gets theirs back, along with any commands waiting for it. One working
// direction is enough: if the phone can't reach the PC (firewall), the PC's next sync to the
// phone collects the phone's commands. Every device therefore knows what the others are playing,
// with the whole queue and position, which drives the "Listening on …" bar and "Play here".
// Without any LAN link, the Plex server's session list still gives the track and position.
//
// Controlling: picking another device routes every `player` action to it and mirrors its state
// into usePlayer, so the whole UI (player bar, queue, lyrics) follows the remote device.
import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { fetch } from "@tauri-apps/plugin-http";
import { PRODUCT, Track, VERSION, clientId, getUser, isOurs, plexHeaders, setPlexDeviceName, toTrack } from "./plex";
import { currentTrack, player, playerFlags, usePlayer } from "./player";
import { fmtTime, server, toast, useSession, useSettings } from "./store";
import { isAndroid } from "./platform";

export { isAndroid };

export interface Device {
  /** Connected headphones or speakers, when the device knows. */
  output?: string;
  name: string;
  host: string;
  port: number;
  clientId: string;
  product: string;
  deviceClass: string;
}

/** Everything another device needs to show, mirror or take over this one's playback. */
export type Snapshot = Pick<
  ReturnType<typeof usePlayer.getState>,
  "queue" | "index" | "position" | "duration" | "paused" | "loaded" | "buffering" | "volume" | "muted" | "shuffle" | "repeat" | "stopAfter"
> & { version: number; playingSince: number; queueVersion: number };

/** Another device, as last heard from (directly, or through the Plex server). */
export interface Peer {
  device: Device;
  /** Full state from a sync, with the local time it arrived. */
  state: Snapshot | null;
  stateAt: number;
  /** What the Plex server says it's playing, when there's no direct link. */
  session: { track: Track; position: number; playing: boolean; at: number } | null;
  /** Whether this device can open connections to it. */
  reachable: boolean;
  lastSeen: number;
}

interface RemoteState {
  peers: Record<string, Peer>;
  scanning: boolean;
  target: Device | null;
}

export const useRemote = create<RemoteState>(() => ({ peers: {}, scanning: false, target: null }));

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
let playingSince = 0;
let queueVersion = 0;

function signature(s: ReturnType<typeof usePlayer.getState>) {
  return [s.queue.map((q) => q.uid).join(","), s.index, s.paused, s.loaded, s.buffering, s.volume, s.muted, s.shuffle, s.repeat, s.stopAfter, Math.round(s.duration)].join("|");
}

function watchState() {
  usePlayer.subscribe((s, p) => {
    if (s.queue !== p.queue) queueVersion++;
    const playing = s.loaded && !s.paused && !playerFlags.remote;
    if (playing && !(p.loaded && !p.paused)) playingSince = Date.now();
    if (!playing) playingSince = 0;
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
    playingSince,
    queueVersion,
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
    if (p === "/tonearm/sync") {
      const msg = JSON.parse(r.body || "{}") as SyncMessage;
      if (!msg.device?.clientId) return { status: 400, contentType: "text/plain", body: "bad sync" };
      receivePeer({ ...msg.device, host: r.from }, msg.state, true);
      for (const c of msg.commands ?? []) await runCommand(c);
      const reply: SyncMessage = { device: myDevice(), state: stateFor(msg.have), commands: takeOutbox(msg.device.clientId), have: queueVersionOf(msg.device.clientId) };
      return { status: 200, contentType: "application/json", body: JSON.stringify(reply) };
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
  if (isAndroid()) return /Android [^;]*; ([^;)]+?)(?: Build|\))/.exec(navigator.userAgent)?.[1] ?? "Android";
  return hostName || "Desktop";
}

async function announce() {
  setPlexDeviceName(deviceName());
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


function myDevice(): Omit<Device, "host"> {
  return {
    name: deviceName(),
    port: myPort,
    clientId: clientId(),
    product: PRODUCT,
    deviceClass: isAndroid() ? "phone" : "pc",
    output: useOutput.getState().name || undefined,
  };
}

let myPort = 32500;

/** What this device is playing through, when it isn't its own speaker. */
export const useOutput = create<{ name: string }>(() => ({ name: "" }));

export function setOutputName(name: string) {
  useOutput.setState({ name });
  syncSoon();
}

// ---- sync -----------------------------------------------------------------------------------

interface Command {
  method: Routed;
  args: unknown[];
}

interface SyncMessage {
  device: Omit<Device, "host"> & { delta?: boolean };
  /** The queue is left out when the other side already has this version of it. */
  state: Omit<Snapshot, "queue"> & { queue?: Snapshot["queue"] };
  commands: Command[];
  /** The version of our queue the sender last received. */
  have?: number;
}

/** Commands waiting for a device that we can't reach; it collects them when it syncs with us. */
const outbox = new Map<string, Command[]>();

function takeOutbox(id: string) {
  const c = outbox.get(id) ?? [];
  outbox.delete(id);
  return c;
}

function patchPeer(id: string, patch: (p: Peer | undefined) => Peer | null | undefined) {
  useRemote.setState((st) => {
    const next = patch(st.peers[id]);
    const peers = { ...st.peers };
    if (next) peers[id] = next;
    else delete peers[id];
    return { peers };
  });
}

function emptyPeer(d: Device): Peer {
  return { device: d, state: null, stateAt: 0, session: null, reachable: false, lastSeen: 0 };
}

/** Our state for a peer, without the queue if it already has this version of it. */
function stateFor(have: number | undefined): SyncMessage["state"] {
  const { queue, ...rest } = snapshot();
  return have === queueVersion ? rest : { ...rest, queue };
}

const queueVersionOf = (id: string) => peerQueueVersions.get(id);
const peerQueueVersions = new Map<string, number>();

function receivePeer(d: Device, incoming: SyncMessage["state"] | null, inbound: boolean) {
  if (d.clientId === clientId()) return;
  const now = Date.now();
  let state: Snapshot | null = null;
  patchPeer(d.clientId, (p) => {
    const base = p ?? emptyPeer(d);
    if (incoming) state = { ...incoming, queue: incoming.queue ?? base.state?.queue ?? [] };
    if (incoming?.queue) peerQueueVersions.set(d.clientId, incoming.queueVersion);
    return {
      ...base,
      // Keep a known-good address: an inbound request's source address can be a NAT or VPN one.
      device: { ...base.device, ...d, host: base.reachable && inbound ? base.device.host : d.host || base.device.host },
      state: state ?? base.state,
      stateAt: state ? now : base.stateAt,
      lastSeen: now,
    };
  });
  if (state) onPeerState(d.clientId);
}

async function runCommand(c: Command) {
  if (!ROUTED.includes(c.method)) return;
  try {
    await local[c.method](...(c.args ?? []));
  } catch (e) {
    console.warn("remote command", c.method, e);
  }
}

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

const lastTry = new Map<string, number>();
/** The version of our queue each peer has confirmed receiving. */
const sentAck = new Map<string, number | undefined>();

async function syncWith(p: Peer) {
  const id = p.device.clientId;
  if (!p.device.host) return;
  // Unreachable devices get a retry every 20 s; they may reach us instead.
  if (!p.reachable && Date.now() - (lastTry.get(id) ?? 0) < 20_000) return;
  lastTry.set(id, Date.now());
  const commands = takeOutbox(id);
  const msg: SyncMessage = { device: myDevice(), state: stateFor(sentAck.get(id)), commands, have: queueVersionOf(id) };
  try {
    const r = await remoteFetch(p.device, "/tonearm/sync", { method: "POST", body: JSON.stringify(msg) }, 4000);
    const reply = (await r.json()) as SyncMessage;
    patchPeer(id, (cur) => (cur ? { ...cur, reachable: true } : cur));
    sentAck.set(id, reply.have);
    receivePeer({ ...reply.device, host: p.device.host }, reply.state, false);
    for (const c of reply.commands ?? []) await runCommand(c);
  } catch {
    // Not delivered: keep the commands for when the device syncs with us.
    if (commands.length) outbox.set(id, [...commands, ...(outbox.get(id) ?? [])]);
    patchPeer(id, (cur) => (cur ? { ...cur, reachable: false } : cur));
  }
}

let syncing = false;
let syncAgain = false;

async function syncAll() {
  if (syncing) {
    syncAgain = true;
    return;
  }
  syncing = true;
  try {
    do {
      syncAgain = false;
      await Promise.all(Object.values(useRemote.getState().peers).map(syncWith));
    } while (syncAgain);
  } finally {
    syncing = false;
  }
}

let soon = 0;
/** Sync shortly (batches bursts of state changes). */
function syncSoon() {
  clearTimeout(soon);
  soon = window.setTimeout(() => void syncAll(), 250);
}

/** Platter devices on the network, plus anything the Plex server says is playing. */
export async function discover() {
  useRemote.setState({ scanning: true });
  try {
    const me = clientId();
    const gdm = await invoke<Device[]>("remote_discover", { ms: 1200 }).catch(() => [] as Device[]);
    for (const d of gdm) {
      if (isOurs(d.product) && d.clientId !== me) {
        patchPeer(d.clientId, (p) => ({ ...(p ?? emptyPeer(d)), device: { ...(p?.device ?? d), ...d }, lastSeen: Date.now() }));
      }
    }
    await refreshSessions();
    await syncAll();
  } finally {
    useRemote.setState({ scanning: false });
  }
}

/** Plex's view of every player on the account: track and position, no LAN needed. */
async function refreshSessions() {
  const me = clientId();
  let c: any;
  try {
    c = await server().container("/status/sessions");
  } catch {
    return;
  }
  const seen = new Set<string>();
  for (const m of c.Metadata ?? []) {
    const pl = m.Player;
    if (!pl?.machineIdentifier || pl.machineIdentifier === me || m.type !== "track") continue;
    seen.add(pl.machineIdentifier);
    const d: Device = {
      name: String(pl.title || pl.product || "Plex player").replace(/^(Platter|Tonearm)( - | on )/, ""),
      host: isOurs(pl.product) ? pl.address ?? "" : "",
      port: 32500,
      clientId: pl.machineIdentifier,
      product: pl.product ?? "",
      deviceClass: pl.platform === "Android" ? "phone" : "",
    };
    const session = { track: toTrack(m), position: (m.viewOffset ?? 0) / 1000, playing: pl.state === "playing", at: Date.now() };
    patchPeer(d.clientId, (p) => ({
      ...(p ?? emptyPeer(d)),
      device: p ? { ...p.device, host: p.device.host || d.host } : d,
      session,
      lastSeen: Date.now(),
    }));
  }
  for (const [id, p] of Object.entries(useRemote.getState().peers)) {
    if (!seen.has(id) && p.session) patchPeer(id, (cur) => (cur ? { ...cur, session: null } : cur));
  }
}

// ---- what's playing where ------------------------------------------------------------------------

export interface NowPlaying {
  track: Track;
  position: number;
  duration: number;
  playing: boolean;
  /** The full queue, when the device synced it to us. */
  queue: Track[] | null;
  index: number;
  /** Whether we can send it commands (it's a Platter we sync with). */
  controllable: boolean;
}

const FRESH_MS = 15_000;

/** A peer's playback right now, extrapolating the position from when it was reported. */
export function nowPlaying(p: Peer): NowPlaying | null {
  const now = Date.now();
  const st = p.state && now - p.stateAt < FRESH_MS ? p.state : null;
  if (st?.loaded && st.queue[st.index]) {
    const playing = !st.paused && !st.buffering;
    const position = Math.min(st.duration || Infinity, st.position + (playing ? (now - p.stateAt) / 1000 : 0));
    return {
      track: st.queue[st.index].track,
      position,
      duration: st.duration,
      playing,
      queue: st.queue.map((q) => q.track),
      index: st.index,
      controllable: true,
    };
  }
  if (p.session && now - p.session.at < 60_000) {
    const s = p.session;
    const duration = s.track.duration / 1000;
    return {
      track: s.track,
      position: Math.min(duration, s.position + (s.playing ? (now - s.at) / 1000 : 0)),
      duration,
      playing: s.playing,
      queue: null,
      index: 0,
      controllable: isOurs(p.device.product) && (!!st || p.reachable),
    };
  }
  return null;
}

/** Send a command to a device: directly when we can reach it, otherwise via its next sync. */
export function sendCommand(id: string, method: Routed, args: unknown[] = []) {
  outbox.set(id, [...(outbox.get(id) ?? []), { method, args }]);
  syncSoon();
}

/** Bring another device's music here, carrying on from the same track, queue and position. */
export async function playHere(id: string) {
  const p = useRemote.getState().peers[id];
  const np = p && nowPlaying(p);
  if (!np) return;
  if (useRemote.getState().target) await disconnect();
  if (np.controllable) sendCommand(id, "pause");
  const tracks = np.queue ?? [np.track];
  await local.playTracks(tracks, np.index, { shuffle: false, at: np.position });
  toast(`Playing here from ${fmtTime(np.position)}`);
}

/** Send this device's music to another Platter and control it from here. */
export async function playThere(id: string) {
  const p = useRemote.getState().peers[id];
  if (!p) return;
  const s = usePlayer.getState();
  if (s.loaded && s.queue.length) {
    const tracks = s.queue.map((q) => q.track);
    const at = s.position;
    const paused = s.paused;
    await local.stop();
    sendCommand(id, "playTracks", [tracks, s.index, { shuffle: false, at }]);
    if (paused) sendCommand(id, "pause");
  }
  await control(id);
}

// ---- controlling ----------------------------------------------------------------------------

let localSnapshot: Partial<ReturnType<typeof usePlayer.getState>> | null = null;

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

/** Mirror another device here: the player bar, queue and controls all act on it. */
export async function control(id: string) {
  const p = useRemote.getState().peers[id];
  if (!p || useRemote.getState().target?.clientId === id) return;
  if (useRemote.getState().target) await disconnect();
  const s = usePlayer.getState();
  localSnapshot = { queue: s.queue, original: s.original, index: s.index, position: s.position, shuffle: s.shuffle, repeat: s.repeat, volume: s.volume, muted: s.muted };
  if (s.loaded) await local.stop();
  useRemote.setState({ target: p.device });
  playerFlags.remote = true;
  if (p.state) mirror(p.state);
  syncSoon();
}

/** Stop controlling the other device. With `takeOver`, its music moves here. */
export async function disconnect(takeOver = false) {
  const d = useRemote.getState().target;
  if (!d) return;
  const p = useRemote.getState().peers[d.clientId];
  const np = takeOver && p ? nowPlaying(p) : null;
  useRemote.setState({ target: null });
  playerFlags.remote = false;
  usePlayer.setState({ ...(localSnapshot ?? {}), loaded: false, paused: true, buffering: false });
  localSnapshot = null;
  if (np) {
    sendCommand(d.clientId, "pause");
    await local.playTracks(np.queue ?? [np.track], np.index, { shuffle: false, at: np.position });
  }
}

/** New state from a peer: update the mirror, and yield if it started playing after us. */
function onPeerState(id: string) {
  const p = useRemote.getState().peers[id];
  if (!p?.state) return;
  if (useRemote.getState().target?.clientId === id) mirror(p.state);
  const s = usePlayer.getState();
  const here = s.loaded && !s.paused && !playerFlags.remote;
  const there = p.state.loaded && !p.state.paused;
  if (here && there && useSettings.getState().exclusivePlayback && p.state.playingSince > playingSince) {
    void local.pause();
    toast(`Paused here: now playing on ${p.device.name}`, { action: { label: "Control it", run: () => void control(id) } });
  }
}

// ---- one device at a time ---------------------------------------------------------------
//
// Starting playback here pauses every other Platter on the account: through the sync channel
// when there is one, and otherwise each playing device watches the Plex session list and pauses
// itself when another Platter starts after it did. The device that started last wins.

let wasPlaying = false;
let othersPlaying = new Map<string, boolean>();

function playingHere() {
  const s = usePlayer.getState();
  return s.loaded && !s.paused && !playerFlags.remote;
}

function pauseOthers() {
  for (const [id, p] of Object.entries(useRemote.getState().peers)) {
    const np = nowPlaying(p);
    if (np?.playing && np.controllable) sendCommand(id, "pause");
  }
}

async function yieldToNewerDevice() {
  if (!playingHere()) return;
  await refreshSessions();
  if (!playingHere()) return;
  const peers = Object.values(useRemote.getState().peers).filter((p) => isOurs(p.device.product) && p.session);
  const started = peers.find((p) => p.session!.playing && !othersPlaying.get(p.device.clientId));
  othersPlaying = new Map(peers.map((p) => [p.device.clientId, p.session!.playing]));
  if (started) {
    await local.pause();
    toast(`Paused here: now playing on ${started.device.name}`, { action: { label: "Control it", run: () => void control(started.device.clientId) } });
  }
}

function watchExclusive() {
  usePlayer.subscribe(() => {
    const now = playingHere();
    if (now && !wasPlaying) {
      othersPlaying = new Map(
        Object.values(useRemote.getState().peers).map((p) => [p.device.clientId, !!p.session?.playing]),
      );
      if (useSettings.getState().exclusivePlayback) pauseOthers();
    }
    wasPlaying = now;
  });
}

// ---- setup --------------------------------------------------------------------------------

export async function initRemote() {
  for (const m of ROUTED) {
    const orig = (player as any)[m] as (...a: any[]) => any;
    local[m] = orig;
    (player as any)[m] = (...args: any[]) => {
      const t = useRemote.getState().target;
      if (!t) return orig(...args);
      sendCommand(t.clientId, m, args);
    };
  }
  watchState();
  watchExclusive();
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
  myPort = (await announce()) || 32500;
  useSettings.subscribe((s, p) => s.deviceName !== p.deviceName && void announce());
  // Changes here reach the others straight away; otherwise sync briskly while anything plays.
  usePlayer.subscribe((s, p) => {
    if (s.queue !== p.queue || s.index !== p.index || s.paused !== p.paused || s.loaded !== p.loaded) syncSoon();
  });
  const tick = () => {
    const anyPlaying =
      playingHere() || Object.values(useRemote.getState().peers).some((p) => nowPlaying(p)?.playing) || !!useRemote.getState().target;
    void syncAll();
    // In the background nobody's watching progress bars; save the battery.
    setTimeout(tick, document.hidden ? 20_000 : anyPlaying ? 2000 : 8000);
  };
  setTimeout(tick, 1500);
  setTimeout(() => void discover(), 1000);
  setInterval(() => !document.hidden && void discover(), 60_000);
  let sessionTick = 0;
  setInterval(() => {
    // Every 5 s on screen or while playing; once a minute otherwise.
    if (document.hidden && !playingHere() && ++sessionTick % 12) return;
    void refreshSessions();
    if (useSettings.getState().exclusivePlayback) void yieldToNewerDevice();
  }, 5000);
  // Forget devices we haven't heard from in a while.
  setInterval(() => {
    const now = Date.now();
    for (const [id, p] of Object.entries(useRemote.getState().peers)) {
      if (now - p.lastSeen > 5 * 60_000 && useRemote.getState().target?.clientId !== id) patchPeer(id, () => null);
    }
  }, 60_000);
}
