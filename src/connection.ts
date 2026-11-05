// Keeps the app on the best address for the Plex server: every address the server advertises is
// saved, all of them are tried at once, and the best one that answers wins (LAN, then direct
// remote, then relay). Re-checked whenever the network changes, so moving between home and
// mobile data doesn't need a slow one-at-a-time timeout crawl.
import { fetch } from "@tauri-apps/plugin-http";
import { Connection, getServers, plexHeaders } from "./plex";
import { toast, useSession } from "./store";

const PROBE_MS = 2500;
/** Once something answers, how long a better address gets to answer too. */
const GRACE_MS = 500;

const rank = (c: Connection) => (c.relay ? 2 : c.local ? 0 : 1);

async function probe(c: Connection, token: string) {
  const r = await fetch(c.uri + "/identity", {
    headers: plexHeaders(token),
    connectTimeout: PROBE_MS,
    signal: AbortSignal.timeout(PROBE_MS),
  });
  if (!r.ok) throw new Error(String(r.status));
  return c;
}

export function bestConnection(conns: Connection[], token: string): Promise<Connection | null> {
  return new Promise((resolve) => {
    let best: Connection | null = null;
    let pending = conns.length;
    let grace = 0;
    const finish = () => {
      clearTimeout(grace);
      resolve(best);
    };
    if (!pending) return resolve(null);
    for (const c of conns) {
      probe(c, token)
        .then((ok) => {
          if (!best || rank(ok) < rank(best)) best = ok;
          if (rank(best) === 0) return finish();
          if (!grace) grace = window.setTimeout(finish, GRACE_MS);
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
  let best = await bestConnection(known, info.token);
  if (!best) {
    const fresh = await refreshConnections().catch(() => null);
    if (fresh) best = await bestConnection(fresh, useSession.getState().server?.token ?? info.token);
  }
  if (!best) {
    if (report) toast(`Can't reach ${info.name}. Downloaded and local music still plays.`, { error: true });
    return false;
  }
  const cur = useSession.getState().server!;
  if (best.uri === cur.uri) return false;
  useSession.getState().set({ server: { ...cur, uri: best.uri, local: best.local } });
  toast(`Connected to ${cur.name} (${best.relay ? "relay" : best.local ? "local network" : "remote"})`);
  return true;
}

/** Checks at startup and on every sign the network changed. */
export function startConnectionMonitor() {
  void refreshConnections()
    .then(() => ensureConnection())
    .catch(() => undefined);
  const recheck = () => void ensureConnection();
  window.addEventListener("online", recheck);
  document.addEventListener("visibilitychange", () => !document.hidden && recheck());
  setInterval(() => !document.hidden && recheck(), 60_000);
  return recheck;
}
