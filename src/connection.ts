// Keeps the app on the best address for the Plex server: every address the server advertises is
// saved, all of them are tried at once, and the best one that answers wins (LAN, then direct
// remote, then relay). Re-checked whenever the network changes, so moving between home and
// mobile data doesn't need a slow one-at-a-time timeout crawl.
//
// The addresses plex.tv lists are https on plex.direct names, which fail on networks that block DNS
// answers pointing at private addresses. So a LAN address is also tried directly over plain http,
// as a last resort before leaving the LAN.
import { fetch } from "@tauri-apps/plugin-http";
import { Connection, getServers, plexHeaders, ServerInfo, setReconnect } from "./plex";
import { toast, useSession } from "./store";

const PROBE_MS = 2500;
/** Once something answers, how long a better address gets to answer too. */
const GRACE_MS = 500;

const isPlain = (c: Connection) => c.uri.startsWith("http://");
const rank = (c: Connection) => (c.relay ? 3 : !c.local ? 2 : isPlain(c) ? 1 : 0);

/** The listed addresses, plus plain http for each LAN address. */
function candidates(conns: Connection[]) {
  const out = new Map(conns.map((c) => [c.uri, c]));
  for (const c of conns) {
    if (!c.local || c.relay || !c.address || !c.port || c.address.includes(":")) continue;
    const uri = `http://${c.address}:${c.port}`;
    if (!out.has(uri)) out.set(uri, { uri, local: true, relay: false, protocol: "http" });
  }
  return [...out.values()];
}

async function probe(c: Connection, machineId: string, token: string) {
  const get = (path: string, auth?: string) =>
    fetch(c.uri + path, { headers: plexHeaders(auth), connectTimeout: PROBE_MS, signal: AbortSignal.timeout(PROBE_MS) });
  const plain = isPlain(c);
  // Nothing proves who's at a plain address, so it doesn't get the token until it says it's ours.
  const r = await get("/identity", plain ? undefined : token);
  if (!r.ok) throw new Error(String(r.status));
  const id = (await r.json()).MediaContainer?.machineIdentifier;
  if (id ? id !== machineId : plain) throw new Error("A different server answered");
  // A server that requires secure connections still answers /identity over http.
  if (plain && !(await get("/", token)).ok) throw new Error("Server refuses plain http");
  return c;
}

/** With `patient`, waits for a better address as long as it takes to time out, not just a moment. */
export function bestConnection(list: Connection[], machineId: string, token: string, patient = false): Promise<Connection | null> {
  return new Promise((resolve) => {
    const conns = candidates(list);
    let best: Connection | null = null;
    let pending = conns.length;
    let grace = 0;
    const finish = () => {
      clearTimeout(grace);
      resolve(best);
    };
    if (!pending) return resolve(null);
    for (const c of conns) {
      probe(c, machineId, token)
        .then((ok) => {
          if (!best || rank(ok) < rank(best)) best = ok;
          if (rank(best) === 0) return finish();
          if (!grace && !patient) grace = window.setTimeout(finish, GRACE_MS);
        })
        .catch(() => undefined)
        .finally(() => {
          if (--pending === 0) finish();
        });
    }
  });
}

/** Fresh address list from plex.tv (addresses change when the server or its network does). */
async function refreshConnections() {
  const { server: info, token, set } = useSession.getState();
  if (!info || !token) return null;
  const res = (await getServers(token)).find((s) => s.clientIdentifier === info.machineId);
  if (!res) return null;
  const cur = useSession.getState().server;
  if (cur) set({ server: { ...cur, token: res.accessToken, connections: res.connections } });
  return res.connections;
}

let running: Promise<boolean> | null = null;

setReconnect(async () => {
  await ensureConnection();
  return useSession.getState().server ?? null;
});

/**
 * Moves to the best reachable address. Returns true if the address changed. With `report`, says
 * so when the server can't be reached at all.
 */
export function ensureConnection(report = false): Promise<boolean> {
  running ??= check(report).finally(() => (running = null));
  return running;
}

async function check(report: boolean) {
  const { server: info } = useSession.getState();
  if (!info) return false;
  let conns = info.connections ?? [];
  if (!conns.length) conns = (await refreshConnections().catch(() => null)) ?? [];
  // The address in use counts too, even if plex.tv no longer lists it (e.g. typed-in or stale).
  const known = conns.some((c) => c.uri === info.uri) ? conns : [{ uri: info.uri, local: info.local, relay: false, protocol: "" }, ...conns];
  // A startup check holds up the UI. Later ones don't, so a slow LAN still beats a quick relay.
  let best = await bestConnection(known, info.machineId, info.token, !report);
  if (!best) {
    const fresh = await refreshConnections().catch(() => null);
    if (fresh) best = await bestConnection(fresh, info.machineId, useSession.getState().server?.token ?? info.token, !report);
  }
  if (!best) {
    if (report) toast(`Can't reach ${info.name}. Downloaded and local music still plays.`, { error: true });
    return false;
  }
  const cur = useSession.getState().server!;
  if (best.uri === cur.uri) {
    if (cur.local !== best.local) useSession.getState().set({ server: { ...cur, local: best.local } });
    return false;
  }
  const next = { ...cur, uri: best.uri, local: best.local };
  useSession.getState().set({ server: next });
  toast(`Connected to ${cur.name} (${connectionKind(next)})`);
  return true;
}

export function connectionKind(s: ServerInfo) {
  if (s.local) return "local network";
  return s.connections?.find((c) => c.uri === s.uri)?.relay ? "Plex relay" : "remote";
}

/** Checks at startup and on every sign the network changed. */
export function startConnectionMonitor() {
  void refreshConnections()
    .catch(() => null)
    .then(() => ensureConnection());
  const recheck = () => void ensureConnection();
  window.addEventListener("online", recheck);
  document.addEventListener("visibilitychange", () => !document.hidden && recheck());
  // Also fires when a system dialog closes, such as Android's local network permission.
  window.addEventListener("focus", recheck);
  // Off the LAN, keep looking for it even in the background: the music may be playing over a relay.
  let last = Date.now();
  setInterval(() => {
    if (useSession.getState().server?.local && (document.hidden || Date.now() - last < 60_000)) return;
    last = Date.now();
    recheck();
  }, 20_000);
  return recheck;
}
