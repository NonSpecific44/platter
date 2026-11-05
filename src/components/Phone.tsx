// Phone layout: bottom tabs, a compact mini player and full-screen Now Playing, in the spirit of
// the big streaming apps. Used on Android and in very narrow windows.
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown, Heart, Home, Inbox, Library, ListMusic, Mic2, Pause, Play, Search, Settings, X,
} from "lucide-react";
import { Album, Artist, Hub, Playlist, Track } from "../plex";
import { player, usePlayer } from "../player";
import { openMenu, sectionKey, server, useNav, View } from "../store";
import { albumMenu, playAlbum, trackMenu, useData, usePaged, usePlaylists } from "../actions";
import { useRemote } from "../remote";
import { lidarrConfigured } from "../lidarr";
import { Cover, Heart_, Loading } from "./common";
import { SeekBar, Transport, usePlayhead } from "./PlayerBar";
import { LyricsView, QueueList } from "./Panels";
import { DevicesButton, ElsewhereBar, useDevicesSheet } from "./Devices";

// ---- gestures -----------------------------------------------------------------------------

interface DragHandlers {
  /** Called as the finger moves, once the direction is known. */
  onMove?: (axis: "x" | "y", delta: number) => void;
  /** Called on release with the total movement and speed (px/ms). */
  onEnd?: (axis: "x" | "y", delta: number, speed: number) => void;
  /** Return false to leave a touch alone. */
  accept?: (e: React.PointerEvent) => boolean;
}

/** Pointer handlers that work out which way a swipe is going. Tiny movements stay plain taps. */
function useSwipe({ onMove, onEnd, accept }: DragHandlers) {
  const start = useRef<{ x: number; y: number; t: number; axis: "x" | "y" | null; id: number } | null>(null);
  const swiped = useRef(false);
  return {
    onPointerDown(e: React.PointerEvent) {
      swiped.current = false;
      start.current = !accept || accept(e) ? { x: e.clientX, y: e.clientY, t: e.timeStamp, axis: null, id: e.pointerId } : null;
    },
    onPointerMove(e: React.PointerEvent) {
      const s = start.current;
      if (!s) return;
      const dx = e.clientX - s.x;
      const dy = e.clientY - s.y;
      if (!s.axis) {
        if (Math.hypot(dx, dy) < 10) return;
        s.axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
        swiped.current = true;
        (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
      }
      onMove?.(s.axis, s.axis === "x" ? dx : dy);
    },
    onPointerUp(e: React.PointerEvent) {
      const s = start.current;
      start.current = null;
      if (!s?.axis) return;
      const d = s.axis === "x" ? e.clientX - s.x : e.clientY - s.y;
      onEnd?.(s.axis, d, Math.abs(d) / Math.max(1, e.timeStamp - s.t));
    },
    onPointerCancel() {
      const s = start.current;
      start.current = null;
      if (s?.axis) onEnd?.(s.axis, 0, 0);
    },
    onClickCapture(e: React.MouseEvent) {
      // The tap at the end of a swipe isn't a tap.
      if (swiped.current) {
        e.stopPropagation();
        swiped.current = false;
      }
    },
  };
}

function settle(el: HTMLElement | null, css: string, then?: () => void) {
  if (!el) return then?.();
  el.style.transition = "transform 0.2s cubic-bezier(0.2, 0, 0, 1), opacity 0.2s";
  el.style.transform = css;
  setTimeout(() => {
    el.style.transition = "";
    then?.();
  }, 200);
}

/** Swipe right on a page to go back. */
export function useEdgeSwipeBack() {
  const page = () => document.querySelector<HTMLElement>(".app.phone .main");
  return useSwipe({
    // Things that scroll or drag sideways keep their swipes.
    accept: (e) => !(e.target as Element).closest(".shelf-row, .seek-track, .chips, .phone-bar, .elsewhere, .pnp, .sheet, .menu, input, .eq, .qrow"),
    onMove(axis, d) {
      if (axis !== "x" || d <= 0 || useNav.getState().stack.length < 2) return;
      const el = page();
      if (el) el.style.transform = `translateX(${d * 0.6}px)`;
    },
    onEnd(axis, d, speed) {
      const el = page();
      if (axis !== "x" || useNav.getState().stack.length < 2) {
        if (el) el.style.transform = "";
        return;
      }
      if (d > 90 || (d > 40 && speed > 0.6)) useNav.getState().back();
      else settle(el, "");
    },
  });
}

// ---- tabs -------------------------------------------------------------------------------

const TABS: [View["kind"], string, typeof Home, View][] = [
  ["home", "Home", Home, { kind: "home" }],
  ["search", "Search", Search, { kind: "search" }],
  ["library", "Your Library", Library, { kind: "library" }],
];

/** Which tab a view belongs to; pages opened from a tab stay in that tab. */
function tabOf(v: View) {
  if (v.kind === "home" || v.kind === "search" || v.kind === "library") return v.kind;
  return null;
}

function currentTab(stack: View[]) {
  for (let i = stack.length - 1; i >= 0; i--) {
    const t = tabOf(stack[i]);
    if (t) return t;
  }
  return "library";
}

export function PhoneNav() {
  const stack = useNav((s) => s.stack);
  const go = useNav((s) => s.go);
  const tab = currentTab(stack);
  return (
    <nav className="phone-nav">
      {TABS.map(([kind, label, Icon, view]) => (
        <button
          key={kind}
          className={tab === kind ? "on" : ""}
          onClick={() => {
            // Tapping the current tab again returns to its top level.
            if (tab === kind) {
              const root = stack.map(tabOf).lastIndexOf(kind);
              useNav.setState({ stack: root >= 0 ? stack.slice(0, root + 1) : [view], forward: [] });
            }
            else go(view);
          }}
        >
          <Icon size={24} strokeWidth={tab === kind ? 2.4 : 1.8} />
          <span>{label}</span>
        </button>
      ))}
    </nav>
  );
}

// ---- mini player ----------------------------------------------------------------------------

export function PhoneBar() {
  const track = usePlayer((s) => s.queue[s.index]?.track);
  const paused = usePlayer((s) => s.paused || !s.loaded);
  const target = useRemote((s) => s.target);
  const setNowPlaying = useNav((s) => s.setNowPlaying);
  const fill = useRef<HTMLDivElement>(null);
  usePlayhead((sec) => {
    const d = usePlayer.getState().duration;
    if (fill.current) fill.current.style.transform = `scaleX(${d ? Math.min(1, sec / d) : 0})`;
  });
  const bar = useRef<HTMLDivElement>(null);
  // Sideways to skip, up to open.
  const swipe = useSwipe({
    onMove(axis, d) {
      if (bar.current && axis === "x") bar.current.style.transform = `translateX(${d}px)`;
    },
    onEnd(axis, d, speed) {
      if (axis === "y") {
        if (d < -30 || (d < -10 && speed > 0.4)) setNowPlaying(true);
        return;
      }
      const far = Math.abs(d) > 90 || (Math.abs(d) > 40 && speed > 0.6);
      settle(bar.current, "");
      if (far) void (d < 0 ? player.next() : player.previous());
    },
  });
  return (
    <div className="phone-bar-wrap">
      <ElsewhereBar />
      {track && (
        <div className="phone-bar" ref={bar} onClick={() => setNowPlaying(true)} {...swipe}>
          <Cover thumb={track.thumb} className="phone-bar-art" />
          <div className="phone-bar-text">
            <div className="phone-bar-title">{track.title}</div>
            <div className={`phone-bar-sub ${target ? "remote" : ""}`}>{target ? `Playing on ${target.name}` : track.artist}</div>
          </div>
          <span onClick={(e) => e.stopPropagation()}>
            <DevicesButton />
          </span>
          <button
            className="icon-btn phone-bar-play"
            onClick={(e) => {
              e.stopPropagation();
              void player.toggle();
            }}
            title={paused ? "Play" : "Pause"}
          >
            {paused ? <Play size={24} fill="currentColor" /> : <Pause size={24} fill="currentColor" />}
          </button>
          <div className="phone-bar-progress">
            <div ref={fill} />
          </div>
        </div>
      )}
    </div>
  );
}

// ---- now playing ---------------------------------------------------------------------------

export function PhoneNowPlaying() {
  const { nowPlaying, setNowPlaying, go } = useNav();
  const track = usePlayer((s) => s.queue[s.index]?.track);
  const target = useRemote((s) => s.target);
  const openDevices = useDevicesSheet((s) => s.set);
  const [pane, setPane] = useState<"art" | "lyrics" | "queue">("art");
  const sheet = useRef<HTMLDivElement>(null);
  const art = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!nowPlaying) setPane("art");
  }, [nowPlaying]);
  // Down to minimise, sideways to change track.
  const swipe = useSwipe({
    onMove(axis, d) {
      if (axis === "y" && d > 0 && sheet.current) sheet.current.style.transform = `translateY(${d}px)`;
      if (axis === "x" && art.current) {
        art.current.style.transform = `translateX(${d}px) rotate(${d / 60}deg)`;
        art.current.style.opacity = String(Math.max(0.4, 1 - Math.abs(d) / 500));
      }
    },
    onEnd(axis, d, speed) {
      if (axis === "y") {
        if (d > 120 || (d > 50 && speed > 0.6)) {
          settle(sheet.current, "translateY(100%)", () => {
            if (sheet.current) sheet.current.style.transform = "";
            setNowPlaying(false);
          });
        } else {
          settle(sheet.current, "");
        }
        return;
      }
      const el = art.current;
      const far = Math.abs(d) > 90 || (Math.abs(d) > 40 && speed > 0.6);
      if (el) el.style.opacity = "";
      settle(el, "");
      if (far) void (d < 0 ? player.next() : player.previous());
    },
  });
  if (!nowPlaying) return null;
  const bg = track ? server().imageUrl(track.thumb, 400) : undefined;
  const goTo = (v: View) => {
    setNowPlaying(false);
    go(v);
  };
  return (
    <div className="pnp" ref={sheet}>
      {bg && <div className="np-bg" style={{ backgroundImage: `url("${bg}")` }} />}
      <div className="np-shade" />
      <header className="pnp-head" {...swipe}>
        <button className="icon-btn" onClick={() => setNowPlaying(false)} title="Close">
          <ChevronDown size={28} />
        </button>
        <div className="pnp-context">
          <span>{target ? `Playing on ${target.name}` : "Now playing"}</span>
          <strong>{track?.album}</strong>
        </div>
        <button className="icon-btn" title="More" onClick={(e) => track && openMenu(e, trackMenu([track], {}))}>
          ⋯
        </button>
      </header>
      <div className={`pnp-body ${pane === "art" ? "swipeable" : ""}`} {...(pane === "art" ? swipe : {})}>
        {pane === "art" ? (
          <div className="pnp-art-wrap" ref={art}>
            <Cover thumb={track?.thumb} className="pnp-art" icon="album" />
          </div>
        ) : (
          <div className="pnp-pane">{pane === "lyrics" ? <LyricsView big /> : <QueueList limit={100} />}</div>
        )}
      </div>
      {track && (
        <div className="pnp-meta">
          <div className="pnp-titlerow">
            <div className="pnp-titles">
              <div className="pnp-title" onClick={() => track.albumKey && goTo({ kind: "album", id: track.albumKey })}>
                {track.title}
              </div>
              <div className="pnp-artist" onClick={() => track.artistKey && goTo({ kind: "artist", id: track.artistKey })}>
                {track.artist}
              </div>
            </div>
            <Heart_ t={track} />
          </div>
          <SeekBar />
          <div className="pnp-controls">
            <Transport size={30} />
          </div>
          <div className="pnp-extras">
            <button className={`icon-btn ${target ? "on" : ""}`} onClick={() => openDevices(true)} title="Devices">
              <span className="pnp-device">{target ? target.name : "Devices"}</span>
            </button>
            <div className="grow" />
            <button className={`icon-btn toggle ${pane === "lyrics" ? "on" : ""}`} onClick={() => setPane(pane === "lyrics" ? "art" : "lyrics")} title="Lyrics">
              <Mic2 size={20} />
            </button>
            <button className={`icon-btn toggle ${pane === "queue" ? "on" : ""}`} onClick={() => setPane(pane === "queue" ? "art" : "queue")} title="Queue">
              <ListMusic size={20} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---- list rows -----------------------------------------------------------------------------

function Row({ thumb, round, title, sub, onClick, onMenu, icon }: {
  thumb?: string;
  round?: boolean;
  title: string;
  sub: string;
  onClick: () => void;
  onMenu?: (e: React.MouseEvent) => void;
  icon?: React.ReactNode;
}) {
  return (
    <div className="lrow" onClick={onClick} onContextMenu={onMenu}>
      {icon ?? <Cover thumb={thumb} round={round} className="lrow-art" icon={round ? "artist" : "album"} />}
      <div className="lrow-text">
        <div className="lrow-title">{title}</div>
        <div className="lrow-sub">{sub}</div>
      </div>
      {onMenu && (
        <button
          className="icon-btn lrow-more"
          onClick={(e) => {
            e.stopPropagation();
            onMenu(e);
          }}
        >
          ⋯
        </button>
      )}
    </div>
  );
}

/** Renders a long list a page at a time as you scroll. */
function useProgressive(total: number, page = 60) {
  const [limit, setLimit] = useState(page);
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => setLimit(page), [total, page]);
  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver((e) => e[0].isIntersecting && setLimit((l) => l + page), { rootMargin: "600px" });
    io.observe(el);
    return () => io.disconnect();
  }, [page, limit, total]);
  return { limit, sentinel: limit < total ? <div ref={sentinel} style={{ height: 1 }} /> : null };
}

function PageHead({ title }: { title: string }) {
  const go = useNav((s) => s.go);
  return (
    <header className="phone-head">
      <h1>{title}</h1>
      <button className="icon-btn" onClick={() => go({ kind: "settings" })} title="Settings">
        <Settings size={22} />
      </button>
    </header>
  );
}

// ---- library -------------------------------------------------------------------------------

const CHIPS: ["playlists" | "artists" | "albums", string][] = [
  ["playlists", "Playlists"],
  ["artists", "Artists"],
  ["albums", "Albums"],
];

export function LibraryView({ tab = "playlists" }: { tab?: "playlists" | "artists" | "albums" }) {
  const nav = useNav();
  const setTab = (t: typeof tab) => useNav.setState((s) => ({ stack: [...s.stack.slice(0, -1), { kind: "library", tab: t }] }));
  return (
    <div className="view phone-view">
      <PageHead title="Your Library" />
      <div className="chips phone-chips">
        {CHIPS.map(([k, label]) => (
          <button key={k} className={`chip ${tab === k ? "on" : ""}`} onClick={() => setTab(k)}>
            {label}
          </button>
        ))}
        <button className="chip" onClick={() => nav.go({ kind: "local" })}>
          On this device
        </button>
      </div>
      {tab === "playlists" && <PlaylistRows go={nav.go} />}
      {tab === "artists" && <ArtistRows go={nav.go} />}
      {tab === "albums" && <AlbumRows go={nav.go} />}
    </div>
  );
}

function PlaylistRows({ go }: { go: (v: View) => void }) {
  const lists = useData("playlists", () => server().playlists());
  usePlaylists();
  return (
    <div className="lrows">
      <Row
        title="Loved tracks"
        sub="Auto playlist"
        icon={
          <div className="cover loved-cover lrow-art">
            <Heart size={20} fill="currentColor" />
          </div>
        }
        onClick={() => go({ kind: "playlist", id: "loved" })}
      />
      <Row
        title="Queue"
        sub="What's playing and up next"
        icon={
          <div className="cover mix-cover lrow-art">
            <ListMusic size={20} />
          </div>
        }
        onClick={() => go({ kind: "queue" })}
      />
      {lists.loading && <Loading />}
      {lists.data?.map((p: Playlist) => (
        <Row
          key={p.ratingKey}
          thumb={p.thumb}
          title={p.title}
          sub={`Playlist · ${p.leafCount} tracks`}
          onClick={() => go({ kind: "playlist", id: p.ratingKey })}
        />
      ))}
    </div>
  );
}

function ArtistRows({ go }: { go: (v: View) => void }) {
  const sec = sectionKey();
  const { items, done } = usePaged(`artists:${sec}:titleSort`, (s, n) => server().artists(sec, "titleSort", s, n));
  const { limit, sentinel } = useProgressive(items.length);
  return (
    <div className="lrows">
      {!items.length && !done && <Loading />}
      {items.slice(0, limit).map((a: Artist) => (
        <Row key={a.ratingKey} thumb={a.thumb} round title={a.title} sub="Artist" onClick={() => go({ kind: "artist", id: a.ratingKey })} />
      ))}
      {sentinel}
    </div>
  );
}

function AlbumRows({ go }: { go: (v: View) => void }) {
  const sec = sectionKey();
  const sort = "addedAt:desc";
  const { items, done } = usePaged(`albums:${sec}:${sort}::false`, (s, n) => server().albums(sec, { sort, unplayed: false }, s, n));
  const { limit, sentinel } = useProgressive(items.length);
  return (
    <div className="lrows">
      {!items.length && !done && <Loading />}
      {items.slice(0, limit).map((a: Album) => (
        <Row
          key={a.ratingKey}
          thumb={a.thumb}
          title={a.title}
          sub={`Album · ${a.artist}`}
          onClick={() => go({ kind: "album", id: a.ratingKey })}
          onMenu={(e) => openMenu(e, albumMenu(a))}
        />
      ))}
      {sentinel}
    </div>
  );
}

// ---- search --------------------------------------------------------------------------------

export function SearchView() {
  const go = useNav((s) => s.go);
  const [q, setQ] = useState("");
  const [hubs, setHubs] = useState<Hub[]>([]);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) {
      setHubs([]);
      return;
    }
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        setHubs(await server().search(sectionKey(), term));
      } catch {
        setHubs([]);
      }
      setLoading(false);
    }, 220);
    return () => clearTimeout(t);
  }, [q]);
  const order = ["track", "artist", "album", "playlist"];
  const sorted = useMemo(() => [...hubs].sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type)), [hubs]);
  return (
    <div className="view phone-view">
      <PageHead title="Search" />
      <div className="phone-search">
        <Search size={20} />
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Artists, songs or albums" enterKeyHint="search" />
        {q && (
          <button className="icon-btn" onClick={() => setQ("")} title="Clear">
            <X size={18} />
          </button>
        )}
      </div>
      {loading && !hubs.length && <Loading />}
      {sorted.map((h) => (
        <section key={h.hubIdentifier} className="phone-section">
          <h2>{h.title}</h2>
          <div className="lrows">
            {h.items.slice(0, h.type === "track" ? 6 : 8).map((it) => {
              if (h.type === "track") {
                const t = it as Track;
                const tracks = h.items as Track[];
                return (
                  <Row
                    key={t.ratingKey}
                    thumb={t.thumb}
                    title={t.title}
                    sub={`Song · ${t.artist}`}
                    onClick={() => void player.playTracks(tracks, tracks.indexOf(t))}
                    onMenu={(e) => openMenu(e, trackMenu([t], {}))}
                  />
                );
              }
              if (h.type === "artist") {
                const a = it as Artist;
                return <Row key={a.ratingKey} thumb={a.thumb} round title={a.title} sub="Artist" onClick={() => go({ kind: "artist", id: a.ratingKey })} />;
              }
              if (h.type === "album") {
                const a = it as Album;
                return (
                  <Row
                    key={a.ratingKey}
                    thumb={a.thumb}
                    title={a.title}
                    sub={`Album · ${a.artist}`}
                    onClick={() => go({ kind: "album", id: a.ratingKey })}
                    onMenu={(e) => openMenu(e, albumMenu(a))}
                  />
                );
              }
              const p = it as Playlist;
              return <Row key={p.ratingKey} thumb={p.thumb} title={p.title} sub="Playlist" onClick={() => go({ kind: "playlist", id: p.ratingKey })} />;
            })}
          </div>
        </section>
      ))}
      {q.trim().length >= 2 && !loading && !hubs.length && <p className="dim pad">Nothing found for “{q.trim()}”.</p>}
      {lidarrConfigured() && q.trim().length >= 2 && (
        <button className="btn request-link" onClick={() => go({ kind: "requests" })}>
          <Inbox size={16} /> Not here? Request it
        </button>
      )}
    </div>
  );
}

// ---- home extras ---------------------------------------------------------------------------

/** "Jump back in": recently played albums as compact two-column tiles. */
export function RecentTiles() {
  const history = usePlayer((s) => s.history);
  const go = useNav((s) => s.go);
  const albums = useMemo(() => {
    const seen = new Set<string>();
    const out: Track[] = [];
    for (const t of history) {
      const k = t.albumKey ?? t.ratingKey;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(t);
      if (out.length === 6) break;
    }
    return out;
  }, [history]);
  if (!albums.length) return null;
  return (
    <div className="recent-tiles">
      {albums.map((t) => (
        <div
          key={t.albumKey ?? t.ratingKey}
          className="recent-tile"
          onClick={() => t.albumKey && go({ kind: "album", id: t.albumKey })}
          onContextMenu={(e) => t.albumKey && openMenu(e, [{ label: "Play", run: () => playAlbum(t.albumKey!) }])}
        >
          <Cover thumb={t.thumb} className="recent-tile-art" />
          <span>{t.album || t.title}</span>
        </div>
      ))}
    </div>
  );
}

export { PageHead };
