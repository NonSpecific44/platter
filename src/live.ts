// Keeps the library fresh: listens to the Plex server's notification socket for library changes
// (new albums, edits, finished scans), falls back to polling, and backs the manual refresh button.
import { create } from "zustand";
import { sectionKey, server, toast, useSession } from "./store";

interface LibraryState {
  /** Bumped whenever cached library data should be refetched. */
  generation: number;
  scanning: boolean;
}

export const useLibrary = create<LibraryState>(() => ({ generation: 0, scanning: false }));

const POLL_MS = 15 * 60_000;
const DEBOUNCE_MS = 3000;

let socket: WebSocket | null = null;
let retry = 0;
let debounce = 0;
let pollTimer = 0;
let connectedUri = "";

function bump() {
  clearTimeout(debounce);
  debounce = window.setTimeout(() => useLibrary.setState((s) => ({ generation: s.generation + 1 })), DEBOUNCE_MS);
}

interface TimelineEntry {
  sectionID?: string | number;
  type?: number;
  state?: number;
}

function onMessage(raw: string) {
  let msg: any;
  try {
    msg = JSON.parse(raw).NotificationContainer;
  } catch {
    return;
  }
  if (!msg) return;
  const sec = sectionKey();
  if (msg.type === "timeline") {
    // Artists (8), albums (9) and tracks (10) finished processing (5) or deleted (9).
    const hit = (msg.TimelineEntry as TimelineEntry[] | undefined)?.some(
      (e) => String(e.sectionID) === sec && [8, 9, 10].includes(e.type ?? 0) && (e.state === 5 || e.state === 9),
    );
    if (hit) bump();
  } else if (msg.type === "activity") {
    for (const a of msg.ActivityNotification ?? []) {
      const act = a.Activity;
      if (a.event === "ended" && typeof act?.type === "string" && act.type.startsWith("library.")) {
        if (useLibrary.getState().scanning) {
          useLibrary.setState({ scanning: false });
          toast("Library scan finished");
        }
        bump();
      }
    }
  }
}

function connect() {
  const s = useSession.getState().server;
  if (!s) return;
  connectedUri = s.uri;
  const url = server().url("/:/websockets/notifications", { "X-Plex-Token": s.token }).replace(/^http/, "ws");
  try {
    socket = new WebSocket(url);
  } catch {
    return; // polling still runs
  }
  socket.onopen = () => (retry = 0);
  socket.onmessage = (e) => typeof e.data === "string" && onMessage(e.data);
  socket.onclose = () => {
    socket = null;
    if (connectedUri !== useSession.getState().server?.uri) return;
    retry = Math.min(retry + 1, 6);
    setTimeout(() => connectedUri === useSession.getState().server?.uri && connect(), 1000 * 2 ** retry);
  };
}

/** Starts (or restarts, after a server change) live library updates. */
export function startLive() {
  const uri = useSession.getState().server?.uri ?? "";
  if (uri === connectedUri && socket) return;
  connectedUri = "";
  socket?.close();
  socket = null;
  clearInterval(pollTimer);
  if (!uri) return;
  connect();
  pollTimer = window.setInterval(bump, POLL_MS);
}

/** Refetches everything on screen; with `scan`, also asks Plex to rescan the library folders. */
export async function refreshLibrary(scan: boolean) {
  useLibrary.setState((s) => ({ generation: s.generation + 1 }));
  if (!scan) return;
  try {
    await server().request(`/library/sections/${sectionKey()}/refresh`);
    useLibrary.setState({ scanning: true });
    toast("Scanning your library for changes…");
    // If the socket isn't connected, nothing reports the end of the scan; stop the spinner anyway.
    setTimeout(() => useLibrary.getState().scanning && useLibrary.setState({ scanning: false }), 120_000);
  } catch (e) {
    toast(`Couldn't start a library scan: ${e}`, { error: true });
  }
}
