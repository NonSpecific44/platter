// App-wide state: settings, session, navigation, toasts and context menus.
import { create } from "zustand";
import { Server, ServerInfo, PlexUser } from "./plex";

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
  } catch {
    return fallback;
  }
}

/** Throttled write of a slice of a store to localStorage. */
export function persist<T extends object>(
  key: string,
  store: { subscribe: (fn: (s: T) => void) => void; getState: () => T },
  pick: (s: T) => unknown,
  everyMs = 500,
) {
  let pending = false;
  const write = () => {
    pending = false;
    try {
      localStorage.setItem(key, JSON.stringify(pick(store.getState())));
    } catch {
      /* storage full or unavailable */
    }
  };
  store.subscribe(() => {
    if (pending) return;
    pending = true;
    window.setTimeout(write, everyMs);
  });
  window.addEventListener("beforeunload", write);
}

export function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

// ---- settings --------------------------------------------------------------

export const EQ_BANDS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

export const EQ_PRESETS: Record<string, number[]> = {
  Flat: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  "Bass boost": [6, 5, 4, 2, 0, 0, 0, 0, 0, 0],
  "Treble boost": [0, 0, 0, 0, 0, 1, 2, 4, 5, 6],
  "V-shape": [5, 4, 2, 0, -2, -2, 0, 2, 4, 5],
  Vocal: [-2, -2, -1, 1, 3, 4, 3, 1, 0, -1],
  Rock: [4, 3, 2, 0, -1, -1, 1, 2, 3, 4],
  Electronic: [5, 4, 1, 0, -2, 1, 0, 1, 4, 5],
  Acoustic: [3, 3, 2, 1, 1, 1, 2, 2, 2, 1],
  "Late night": [3, 2, 1, 0, 0, 0, -1, -2, -3, -4],
};

export interface Settings {
  theme: "system" | "dark" | "light";
  accentFromArt: boolean;
  accent: string;
  uiScale: number;
  showWaveform: boolean;
  gapless: boolean;
  replaygain: "no" | "track" | "album";
  replaygainPreamp: number;
  audioDevice: string;
  speed: number;
  transcode: "never" | "remote" | "always";
  transcodeKbps: number;
  eqEnabled: boolean;
  eqGains: number[];
  eqPreamp: number;
  eqPreset: string;
  lyricsFallback: boolean;
  closeToTray: boolean;
  notifications: boolean;
  resumePaused: boolean;
  syncRatings: boolean;
  reportToPlex: boolean;
  smartShuffle: boolean;
  sidebarCollapsed: boolean;
  settingsVersion: number;
  /** Shown to other devices; empty means "Tonearm on <hostname>". */
  deviceName: string;
  /** Keep playing similar music when the queue runs out. */
  autoplay: boolean;
  /** Starting playback here pauses Tonearm on your other devices. */
  exclusivePlayback: boolean;
  autoUpdateCheck: boolean;
  /** Read access to the release repository while it is private. */
  githubToken: string;
}

const defaultSettings: Settings = {
  theme: "system",
  accentFromArt: true,
  accent: "#f5873a",
  uiScale: 1,
  showWaveform: true,
  gapless: true,
  replaygain: "album",
  replaygainPreamp: 0,
  audioDevice: "auto",
  speed: 1,
  transcode: "never",
  transcodeKbps: 320,
  eqEnabled: false,
  eqGains: [...EQ_PRESETS.Flat],
  eqPreamp: 0,
  eqPreset: "Flat",
  lyricsFallback: true,
  closeToTray: true,
  notifications: true,
  resumePaused: true,
  syncRatings: true,
  reportToPlex: true,
  smartShuffle: true,
  sidebarCollapsed: false,
  settingsVersion: 2,
  deviceName: "",
  autoplay: true,
  exclusivePlayback: true,
  autoUpdateCheck: true,
  githubToken: "",
};

function migrate(s: Settings): Settings {
  // v2: close to tray became the default.
  if (s.settingsVersion < 2) s = { ...s, closeToTray: true };
  return { ...s, settingsVersion: 2 };
}

export const useSettings = create<Settings & { set: (p: Partial<Settings>) => void }>((set) => ({
  ...migrate(load("tonearm.settings", { ...defaultSettings, settingsVersion: 1 })),
  set: (p) => set(p),
}));
persist("tonearm.settings", useSettings, ({ set: _s, ...rest }) => rest);

// ---- session ---------------------------------------------------------------

interface SessionState {
  token?: string;
  user?: PlexUser;
  server?: ServerInfo;
  section?: { key: string; title: string };
  set: (p: Partial<Omit<SessionState, "set" | "signOut">>) => void;
  signOut: () => void;
}

export const useSession = create<SessionState>((set) => ({
  ...load<Partial<SessionState>>("tonearm.session", {}),
  set: (p) => set(p),
  signOut: () => set({ token: undefined, user: undefined, server: undefined, section: undefined }),
}));
persist("tonearm.session", useSession, ({ token, user, server, section }) => ({ token, user, server, section }));

let cachedServer: Server | undefined;
export function server(): Server {
  const info = useSession.getState().server;
  if (!info) throw new Error("No server selected");
  if (!cachedServer || cachedServer.info !== info) cachedServer = new Server(info);
  return cachedServer;
}
export const sectionKey = () => useSession.getState().section?.key ?? "";

// ---- navigation ------------------------------------------------------------

export type View =
  | { kind: "home" }
  | { kind: "artists" }
  | { kind: "albums"; genre?: string }
  | { kind: "artist"; id: string }
  | { kind: "album"; id: string }
  | { kind: "playlists" }
  | { kind: "playlist"; id: string }
  | { kind: "queue" }
  | { kind: "settings" }
  | { kind: "library"; tab?: "playlists" | "artists" | "albums" }
  | { kind: "search" };

interface NavState {
  stack: View[];
  forward: View[];
  go: (v: View) => void;
  back: () => void;
  fwd: () => void;
  panel: "none" | "queue" | "lyrics";
  setPanel: (p: NavState["panel"]) => void;
  nowPlaying: boolean;
  setNowPlaying: (v: boolean) => void;
  palette: boolean;
  setPalette: (v: boolean) => void;
  help: boolean;
  setHelp: (v: boolean) => void;
  mini: boolean;
  setMini: (v: boolean) => void;
}

const savedNav = load<{ panel: NavState["panel"]; view: View }>("tonearm.nav", { panel: "queue", view: { kind: "home" } });

export const useNav = create<NavState>((set) => ({
  stack: [savedNav.view],
  forward: [],
  go: (v) =>
    set((s) => {
      const cur = s.stack[s.stack.length - 1];
      if (JSON.stringify(cur) === JSON.stringify(v)) return {};
      return { stack: [...s.stack.slice(-50), v], forward: [] };
    }),
  back: () =>
    set((s) => (s.stack.length > 1 ? { stack: s.stack.slice(0, -1), forward: [s.stack[s.stack.length - 1], ...s.forward] } : {})),
  fwd: () => set((s) => (s.forward.length ? { stack: [...s.stack, s.forward[0]], forward: s.forward.slice(1) } : {})),
  panel: savedNav.panel,
  setPanel: (panel) => set({ panel }),
  nowPlaying: false,
  setNowPlaying: (nowPlaying) => set({ nowPlaying }),
  palette: false,
  setPalette: (palette) => set({ palette }),
  help: false,
  setHelp: (help) => set({ help }),
  mini: false,
  setMini: (mini) => set({ mini }),
}));
persist("tonearm.nav", useNav, (s) => ({ panel: s.panel, view: s.stack[s.stack.length - 1] }));

export const currentView = () => {
  const s = useNav.getState().stack;
  return s[s.length - 1];
};

// ---- toasts ----------------------------------------------------------------

export interface Toast {
  id: number;
  text: string;
  action?: { label: string; run: () => void };
  error?: boolean;
}

let toastId = 0;
export const useToasts = create<{ toasts: Toast[]; dismiss: (id: number) => void }>((set) => ({
  toasts: [],
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

export function toast(text: string, opts: { action?: Toast["action"]; error?: boolean } = {}) {
  const id = ++toastId;
  useToasts.setState((s) => ({ toasts: [...s.toasts.slice(-3), { id, text, ...opts }] }));
  setTimeout(() => useToasts.getState().dismiss(id), opts.action ? 7000 : 4000);
}

// ---- context menu ----------------------------------------------------------

export interface MenuItem {
  label: string;
  icon?: React.ReactNode;
  run?: () => void;
  submenu?: MenuItem[];
  danger?: boolean;
  separator?: boolean;
  disabled?: boolean;
}

export const useMenu = create<{ x: number; y: number; items: MenuItem[] | null; close: () => void }>((set) => ({
  x: 0,
  y: 0,
  items: null,
  close: () => set({ items: null }),
}));

export function openMenu(e: { clientX: number; clientY: number; preventDefault: () => void; stopPropagation: () => void }, items: MenuItem[]) {
  e.preventDefault();
  e.stopPropagation();
  useMenu.setState({ x: e.clientX, y: e.clientY, items });
}

// ---- misc ------------------------------------------------------------------

export function fmtTime(sec: number) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

export function fmtDuration(ms: number) {
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} hr ${min % 60} min`;
}
