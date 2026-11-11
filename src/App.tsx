import { useEffect, useRef } from "react";

import { initPlayer, offerHandoff, player, usePlayer } from "./player";
import { refreshLibrary, startLive, useLibrary } from "./live";
import { invoke } from "@tauri-apps/api/core";
import { initRemote } from "./remote";
import { applyScheme } from "./theme";
import { ensureConnection, startConnectionMonitor } from "./connection";
import { DevicesSheet } from "./components/Devices";
import { MetadataEditor } from "./components/Metadata";
import { LocalView } from "./views/Local";
import { RequestsView } from "./views/Requests";
import { initLocal } from "./local";
import { LibraryView, PhoneBar, PhoneNav, PhoneNowPlaying, PullToRefresh, SearchView, useEdgeSwipeBack } from "./components/Phone";
import { isAndroid, isTv, useIsPhone } from "./platform";
import { startTvNavigation } from "./tv";
import { initAndroid, initBackButton } from "./backButton";
import { startUpdateChecks } from "./updates";
import { server, useNav, useSession, useSettings } from "./store";
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
import { Albums, Artists, Home, Playlists, ShelfView } from "./views/Library";
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

  const scheme = useSettings((s) => s.colorScheme);
  const design = useSettings((s) => s.design);

  useEffect(() => {
    document.documentElement.dataset.design = design;
  }, [design]);

  useEffect(() => {
    // Seen from across the room, so everything is bigger on a TV.
    (document.documentElement.style as any).zoom = String(uiScale * (isTv() ? 1.1 : 1));
  }, [uiScale]);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    let alive = true;
    const setAccent = (c: string) => alive && document.documentElement.style.setProperty("--accent", c);
    const apply = async () => {
      const mode = theme === "system" ? (mq.matches ? "dark" : "light") : theme;
      document.documentElement.dataset.theme = mode;
      const schemeAccent = await applyScheme(scheme, mode);
      if (!alive) return;
      setAccent(schemeAccent ?? accent);
      if (isAndroid()) {
        const color = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim();
        void invoke("system_bars", { color, dark: mode === "dark" }).catch(() => undefined);
      }
      // Only the default scheme tints itself from album art.
      if (!schemeAccent && fromArt && thumb && hasServer) {
        const c = await accentFrom(server().imageUrl(thumb, 64));
        if (c) setAccent(c);
      }
    };
    void apply();
    mq.addEventListener("change", apply);
    return () => {
      alive = false;
      mq.removeEventListener("change", apply);
    };
  }, [theme, scheme, accent, fromArt, thumb, hasServer]);
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
      // On a TV the arrow keys move around the screen instead (tv.ts).
      if (isTv() && e.key.startsWith("Arrow")) return;

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

// ---- layout ----------------------------------------------------------------------------

function CurrentView() {
  const phone = useIsPhone();
  const v = useNav((s) => s.stack[s.stack.length - 1]);
  const depth = useNav((s) => s.stack.length);
  const lastDepth = useRef(depth);
  // Forward slides in from the right, back from the left.
  const motion = depth > lastDepth.current ? "enter-forward" : depth < lastDepth.current ? "enter-back" : "enter-fade";
  useEffect(() => {
    lastDepth.current = depth;
  }, [depth]);
  const ref = useRef<HTMLElement>(null);
  const positions = useRef(new Map<string, number>());
  const key = JSON.stringify(v);
  // Restore scroll position when going back.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.scrollTop = positions.current.get(key) ?? 0;
    let idle = 0;
    const onScroll = () => {
      positions.current.set(key, el.scrollTop);
      el.classList.add("scrolling");
      clearTimeout(idle);
      idle = window.setTimeout(() => el.classList.remove("scrolling"), 150);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      clearTimeout(idle);
      el.removeEventListener("scroll", onScroll);
    };
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
    case "library":
      body = <LibraryView tab={v.tab} />;
      break;
    case "search":
      body = <SearchView />;
      break;
    case "shelf":
      body = <ShelfView v={v} />;
      break;
    case "local":
      body = <LocalView tab={v.tab} />;
      break;
    case "requests":
      body = <RequestsView />;
      break;
  }
  return (
    <main className={`main ${motion}`} ref={ref} key={key}>
      {phone && <PullToRefresh page={ref} />}
      {body}
    </main>
  );
}

function MiniPlayer() {
  const track = usePlayer((s) => s.queue[s.index]?.track);
  return (
    <div className="mini" data-tauri-drag-region>
      <Cover thumb={track?.thumb} className="mini-art" />
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
  const phone = useIsPhone();
  const edgeSwipe = useEdgeSwipeBack();
  useShortcuts();
  useEffect(() => {
    initPlayer();
    if (isAndroid()) {
      initBackButton();
      initAndroid();
    }
    if (isTv()) startTvNavigation();
    void initLocal();
    restoreSaneSize();
    ensureConnection(true).then(() => {
      usePlaylists.getState().refresh();
      void offerHandoff();
      startLive();
      startConnectionMonitor();
      void initRemote();
      startUpdateChecks();
    });
    return useSession.subscribe((s, prev) => {
      if (!prev.server || s.server?.uri === prev.server.uri) return;
      startLive();
      // Anything that failed or stalled at the old address loads again from the new one.
      useLibrary.setState((l) => ({ generation: l.generation + 1 }));
    });
  }, []);

  if (mini) return <MiniPlayer />;
  if (phone)
    return (
      <div className="app phone" {...edgeSwipe}>
        <CurrentView />
        <PhoneBar />
        <PhoneNav />
        <PhoneNowPlaying />
      </div>
    );
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
      <DevicesSheet />
      <MetadataEditor />
      <Toasts />
    </>
  );
}
