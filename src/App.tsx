import { useEffect, useRef } from "react";
import { fetch } from "@tauri-apps/plugin-http";
import { findConnection, getServers, plexHeaders } from "./plex";
import { initPlayer, offerHandoff, player, usePlayer } from "./player";
import { refreshLibrary, startLive } from "./live";
import { initRemote } from "./remote";
import { server, toast, useNav, useSession, useSettings } from "./store";
import { setLoved, ratingOf, usePlaylists } from "./actions";
import { accentFrom } from "./color";
import { restoreSaneSize, toggleMini } from "./mini";
import { PickSection, PickServer, SignIn } from "./components/Login";
import { Sidebar } from "./components/Sidebar";
import { PlayerBar, SeekBar, Transport } from "./components/PlayerBar";
import { SidePanel } from "./components/Panels";
import { NowPlaying } from "./components/NowPlaying";
import { Palette } from "./components/Palette";
import { ContextMenu, Cover, HelpModal, PromptModal, Toasts } from "./components/common";
import { Albums, Artists, Home, Playlists } from "./views/Library";
import { AlbumView, ArtistView, PlaylistView } from "./views/Detail";
import { QueueView, SettingsView } from "./views/Settings";

// ---- theme / accent ------------------------------------------------------------

function useTheme() {
  const theme = useSettings((s) => s.theme);
  const uiScale = useSettings((s) => s.uiScale);
  const accent = useSettings((s) => s.accent);
  const fromArt = useSettings((s) => s.accentFromArt);
  const thumb = usePlayer((s) => s.queue[s.index]?.track.thumb);
  const hasServer = useSession((s) => !!s.server);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      document.documentElement.dataset.theme = theme === "system" ? (mq.matches ? "dark" : "light") : theme;
    };
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [theme]);

  useEffect(() => {
    (document.documentElement.style as any).zoom = String(uiScale);
  }, [uiScale]);

  useEffect(() => {
    let alive = true;
    const set = (c: string) => alive && document.documentElement.style.setProperty("--accent", c);
    set(accent);
    if (fromArt && thumb && hasServer) accentFrom(server().imageUrl(thumb, 64)).then((c) => c && set(c));
    return () => {
      alive = false;
    };
  }, [accent, fromArt, thumb, hasServer]);
}

// ---- keyboard ----------------------------------------------------------------------

function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      const typing = el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable;
      const nav = useNav.getState();
      const s = useSettings.getState();
      const ctrl = e.ctrlKey || e.metaKey;

      if (ctrl && e.key.toLowerCase() === "k") return e.preventDefault(), nav.setPalette(!nav.palette);
      if (ctrl && e.shiftKey && e.key.toLowerCase() === "m") return e.preventDefault(), void toggleMini();
      if (ctrl && e.key === ",") return e.preventDefault(), nav.go({ kind: "settings" });
      if (ctrl && (e.key === "=" || e.key === "+")) return e.preventDefault(), s.set({ uiScale: Math.min(1.5, +(s.uiScale + 0.05).toFixed(2)) });
      if (ctrl && e.key === "-") return e.preventDefault(), s.set({ uiScale: Math.max(0.8, +(s.uiScale - 0.05).toFixed(2)) });
      if (ctrl && e.key === "0") return e.preventDefault(), s.set({ uiScale: 1 });
      if (ctrl && /^[1-5]$/.test(e.key)) {
        e.preventDefault();
        const views = ["home", "artists", "albums", "playlists", "queue"] as const;
        return nav.go({ kind: views[Number(e.key) - 1] } as any);
      }
      if (e.altKey && e.key === "ArrowLeft") return e.preventDefault(), nav.back();
      if (e.altKey && e.key === "ArrowRight") return e.preventDefault(), nav.fwd();
      if (typing || nav.palette || e.altKey) return;

      const p = usePlayer.getState();
      switch (e.key) {
        case " ":
          e.preventDefault();
          return player.toggle();
        case "ArrowRight":
          e.preventDefault();
          return ctrl ? player.next() : player.seekBy(10);
        case "ArrowLeft":
          e.preventDefault();
          return ctrl ? player.previous() : player.seekBy(-10);
        case "ArrowUp":
          e.preventDefault();
          return player.setVolume(p.volume + 5);
        case "ArrowDown":
          e.preventDefault();
          return player.setVolume(p.volume - 5);
      }
      if (ctrl) return;
      switch (e.key.toLowerCase()) {
        case "m":
          return player.toggleMute();
        case "s":
          return player.setShuffle(!p.shuffle);
        case "r":
          return player.cycleRepeat();
        case "l":
          return nav.setPanel(nav.panel === "lyrics" ? "none" : "lyrics");
        case "q":
          return nav.setPanel(nav.panel === "queue" ? "none" : "queue");
        case "f":
          return nav.setNowPlaying(!nav.nowPlaying);
        case "h": {
          const t = p.queue[p.index]?.track;
          if (t) setLoved(t, ratingOf(t) !== 10);
          return;
        }
        case "/":
          e.preventDefault();
          return nav.setPalette(true);
        case "?":
          return nav.setHelp(!nav.help);
        case "f5":
          e.preventDefault();
          return refreshLibrary(e.shiftKey);
      }
    };
    // Mouse back/forward buttons
    const onMouse = (e: MouseEvent) => {
      if (e.button === 3) useNav.getState().back();
      if (e.button === 4) useNav.getState().fwd();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mouseup", onMouse);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mouseup", onMouse);
    };
  }, []);
}

/** The saved address may not work any more (e.g. laptop left home); find a working one. */
async function ensureConnection() {
  const { server: info, token, set } = useSession.getState();
  if (!info || !token) return;
  try {
    const r = await fetch(info.uri + "/identity", { headers: plexHeaders(info.token), connectTimeout: 3000, signal: AbortSignal.timeout(5000) });
    if (r.ok) return;
  } catch {
    /* fall through to rediscovery */
  }
  try {
    const res = (await getServers(token)).find((s) => s.clientIdentifier === info.machineId);
    if (!res) throw new Error("server no longer available on this account");
    const c = await findConnection(res);
    set({ server: { ...info, uri: c.uri, token: res.accessToken, local: c.local } });
    toast(`Reconnected to ${info.name} (${c.relay ? "relay" : c.local ? "local network" : "remote"})`);
  } catch (e) {
    toast(`Can't reach ${info.name}: ${e instanceof Error ? e.message : e}`, { error: true });
  }
}

// ---- layout ----------------------------------------------------------------------------

function CurrentView() {
  const v = useNav((s) => s.stack[s.stack.length - 1]);
  const ref = useRef<HTMLElement>(null);
  const positions = useRef(new Map<string, number>());
  const key = JSON.stringify(v);
  // Restore scroll position when going back.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.scrollTop = positions.current.get(key) ?? 0;
    const onScroll = () => positions.current.set(key, el.scrollTop);
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [key]);
  let body: React.ReactNode;
  switch (v.kind) {
    case "home":
      body = <Home />;
      break;
    case "artists":
      body = <Artists />;
      break;
    case "albums":
      body = <Albums genre={v.genre} />;
      break;
    case "playlists":
      body = <Playlists />;
      break;
    case "artist":
      body = <ArtistView id={v.id} />;
      break;
    case "album":
      body = <AlbumView id={v.id} />;
      break;
    case "playlist":
      body = <PlaylistView id={v.id} />;
      break;
    case "queue":
      body = <QueueView />;
      break;
    case "settings":
      body = <SettingsView />;
      break;
  }
  return (
    <main className="main" ref={ref} key={key}>
      {body}
    </main>
  );
}

function MiniPlayer() {
  const track = usePlayer((s) => s.queue[s.index]?.track);
  return (
    <div className="mini" data-tauri-drag-region>
      <Cover thumb={track?.thumb} size={160} className="mini-art" />
      <div className="mini-body" data-tauri-drag-region>
        <div className="mini-meta" data-tauri-drag-region>
          <div className="mini-title">{track?.title ?? "Nothing playing"}</div>
          <div className="mini-artist dim">{track?.artist}</div>
        </div>
        <Transport size={16} />
        <SeekBar compact />
      </div>
      <button className="icon-btn mini-exit" onClick={toggleMini} title="Exit mini player">
        ⤢
      </button>
    </div>
  );
}

function Main() {
  const panel = useNav((s) => s.panel);
  const mini = useNav((s) => s.mini);
  const collapsed = useSettings((s) => s.sidebarCollapsed);
  useShortcuts();
  useEffect(() => {
    initPlayer();
    restoreSaneSize();
    ensureConnection().then(() => {
      usePlaylists.getState().refresh();
      void offerHandoff();
      startLive();
      void initRemote();
    });
    return useSession.subscribe((s, prev) => s.server?.uri !== prev.server?.uri && startLive());
  }, []);

  if (mini) return <MiniPlayer />;
  return (
    <div className={`app ${panel !== "none" ? "with-panel" : ""} ${collapsed ? "side-collapsed" : ""}`}>
      <Sidebar />
      <CurrentView />
      <SidePanel />
      <PlayerBar />
      <NowPlaying />
      <Palette />
    </div>
  );
}

export default function App() {
  const token = useSession((s) => s.token);
  const hasServer = useSession((s) => !!s.server);
  const hasSection = useSession((s) => !!s.section);
  useTheme();
  return (
    <>
      {!token ? <SignIn /> : !hasServer ? <PickServer /> : !hasSection ? <PickSection /> : <Main />}
      <ContextMenu />
      <PromptModal />
      <HelpModal />
      <Toasts />
    </>
  );
}
