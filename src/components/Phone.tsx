// Phone layout: bottom tabs, a compact mini player and full-screen Now Playing, in the spirit of
// the big streaming apps. Used on Android and in very narrow windows.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown, ChevronRight, Heart, Home, Inbox, Library, ListMusic, Mic2, Pause, Play, Search, Settings, X,
} from "lucide-react";
import { Album, Artist, Hub, Playlist, SEARCH_LIMIT, Track } from "../plex";
import { player, usePlayer } from "../player";
import { openMenu, sectionKey, server, useNav, useSettings, View } from "../store";
import { ALBUM_SORTS, albumMenu, playAlbum, trackMenu, useData, usePaged, usePlaylists } from "../actions";
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

// ---- track carousel --------------------------------------------------------------------------

type TrackAnimation = "slide" | "stack" | "fade" | "none";

/** The tracks either side of the current one, in queue order. */
function useNeighbours() {
  const queue = usePlayer((s) => s.queue);
  const index = usePlayer((s) => s.index);
  const repeat = usePlayer((s) => s.repeat);
  const at = (i: number) => queue[repeat === "all" ? (i + queue.length) % queue.length : i];
  return { prev: at(index - 1), cur: queue[index], next: at(index + 1) };
}

/**
 * Positions the previous, current and next slides for a swipe `p` from -1 (fully on the next
 * track) to 1 (fully on the previous one). Works on the DOM directly so dragging never re-renders.
 */
function placeSlides(box: HTMLElement | null, p: number, mode: TrackAnimation, animate: boolean) {
  if (!box) return;
  const w = box.clientWidth + 28;
  box.querySelectorAll<HTMLElement>("[data-slide]").forEach((el) => {
    const o = Number(el.dataset.slide);
    const d = o + p; // 0 means centred
    let transform = "";
    let opacity = 1;
    let z = 1;
    if (mode === "slide") {
      transform = `translateX(${d * w}px)`;
    } else if (mode === "stack") {
      // The current cover slides away, uncovering the next one beneath it.
      if (d < 0) transform = `translateX(${d * w * 1.1}px) rotate(${d * 8}deg)`;
      else transform = `scale(${1 - Math.min(1, d) * 0.12})`;
      opacity = d > 0 ? 1 - Math.min(1, d) * 0.5 : 1;
      z = 3 - o;
    } else {
      opacity = Math.max(0, 1 - Math.abs(d));
    }
    el.classList.toggle("animating", animate);
    el.style.transform = transform;
    el.style.opacity = String(opacity);
    el.style.zIndex = String(z);
  });
}

/** Drag handling and the follow-through animation shared by Now Playing and the mini player. */
function useTrackCarousel(box: React.RefObject<HTMLElement | null>, has: { prev: boolean; next: boolean }) {
  const mode = useSettings((s) => s.trackAnimation);
  const uid = usePlayer((s) => s.queue[s.index]?.uid);
  const index = usePlayer((s) => s.index);
  const lastIndex = useRef(index);
  const swiping = useRef(false);
  /** A finger or a follow-through animation owns the slides right now. */
  const busy = useRef(false);

  // Slides appear when a screen opens and when the queue changes, so place them on every render.
  useLayoutEffect(() => {
    if (!busy.current) placeSlides(box.current, 0, mode, false);
  });

  // Track changes that didn't come from a swipe animate too.
  useLayoutEffect(() => {
    const from = lastIndex.current;
    lastIndex.current = index;
    if (swiping.current || from === index || mode === "none") {
      swiping.current = false;
      return;
    }
    busy.current = true;
    placeSlides(box.current, index > from ? 1 : -1, mode, false);
    void box.current?.offsetWidth;
    placeSlides(box.current, 0, mode, true);
    const t = setTimeout(() => (busy.current = false), 260);
    return () => clearTimeout(t);
  }, [uid, mode, index]);

  return {
    drag(d: number) {
      busy.current = true;
      const w = box.current?.clientWidth || 300;
      let p = Math.max(-1, Math.min(1, d / w));
      if ((p < 0 && !has.next) || (p > 0 && !has.prev)) p *= 0.2;
      if (mode !== "none") placeSlides(box.current, p, mode, false);
    },
    release(d: number, speed: number) {
      const far = Math.abs(d) > 80 || (Math.abs(d) > 35 && speed > 0.6);
      const go = far && (d < 0 ? has.next : has.prev);
      if (!go) {
        placeSlides(box.current, 0, mode, true);
        setTimeout(() => (busy.current = false), 260);
        return;
      }
      const skip = () => {
        swiping.current = true;
        busy.current = false;
        void (d < 0 ? player.next() : player.previous());
      };
      if (mode === "none") return skip();
      placeSlides(box.current, d < 0 ? -1 : 1, mode, true);
      setTimeout(skip, 230);
    },
  };
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
  const { prev, cur, next } = useNeighbours();
  const slides = useRef<HTMLDivElement>(null);
  const carousel = useTrackCarousel(slides, { prev: !!prev, next: !!next });
  // Sideways to skip, up to open.
  const swipe = useSwipe({
    onMove(axis, d) {
      if (axis === "x") carousel.drag(d);
    },
    onEnd(axis, d, speed) {
      if (axis === "x") carousel.release(d, speed);
      else if (d < -30 || (d < -10 && speed > 0.4)) setNowPlaying(true);
    },
  });
  const slide = (q: NonNullable<typeof cur>, offset: number) => (
    <div className="phone-bar-slide" key={q.uid} data-slide={offset}>
      <Cover thumb={q.track.thumb} className="phone-bar-art" />
      <div className="phone-bar-text">
        <div className="phone-bar-title">{q.track.title}</div>
        <div className={`phone-bar-sub ${target && offset === 0 ? "remote" : ""}`}>{target && offset === 0 ? `Playing on ${target.name}` : q.track.artist}</div>
      </div>
    </div>
  );
  return (
    <div className="phone-bar-wrap">
      <ElsewhereBar />
      {track && (
        <div className="phone-bar" onClick={() => setNowPlaying(true)} {...swipe}>
          <div className="phone-bar-slides" ref={slides}>
            {prev && prev !== cur && slide(prev, -1)}
            {cur && slide(cur, 0)}
            {next && next !== cur && slide(next, 1)}
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
  const { prev, cur, next } = useNeighbours();
  const carousel = useTrackCarousel(art, { prev: !!prev, next: !!next });
  useEffect(() => {
    if (!nowPlaying) setPane("art");
  }, [nowPlaying]);
  // Down to minimise, sideways to change track.
  const swipe = useSwipe({
    onMove(axis, d) {
      if (axis === "y" && d > 0 && sheet.current) sheet.current.style.transform = `translateY(${d}px)`;
      if (axis === "x") carousel.drag(d);
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
      carousel.release(d, speed);
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
          {track?.album && <strong>{track.album}</strong>}
        </div>
        <button className="icon-btn" title="More" onClick={(e) => track && openMenu(e, trackMenu([track], {}))}>
          ⋯
        </button>
      </header>
      <div className={`pnp-body ${pane === "art" ? "swipeable" : ""}`} {...(pane === "art" ? swipe : {})}>
        {pane === "art" ? (
          <div className="pnp-slides" ref={art}>
            {prev && prev !== cur && (
              <div className="pnp-slide" key={prev.uid} data-slide={-1}>
                <Cover thumb={prev.track.thumb} className="pnp-art" icon="album" />
              </div>
            )}
            {cur && (
              <div className="pnp-slide" key={cur.uid} data-slide={0}>
                <Cover thumb={cur.track.thumb} className="pnp-art" icon="album" />
              </div>
            )}
            {next && next !== cur && (
              <div className="pnp-slide" key={next.uid} data-slide={1}>
                <Cover thumb={next.track.thumb} className="pnp-art" icon="album" />
              </div>
            )}
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
              {track.album && (
                <div className="pnp-album" onClick={() => track.albumKey && goTo({ kind: "album", id: track.albumKey })}>
                  {track.album}
                </div>
              )}
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
  const [sort, setSort] = useState(() => localStorage.getItem("tonearm.albumSort") ?? "titleSort");
  const { items, done } = usePaged(`albums:${sec}:${sort}::false`, (s, n) => server().albums(sec, { sort, unplayed: false }, s, n));
  const { limit, sentinel } = useProgressive(items.length);
  return (
    <div className="lrows">
      <label className="sort-row">
        Sort by
        <select
          value={sort}
          onChange={(e) => {
            setSort(e.target.value);
            localStorage.setItem("tonearm.albumSort", e.target.value);
          }}
        >
          {ALBUM_SORTS.map(([k, l]) => (
            <option key={k} value={k}>
              {l}
            </option>
          ))}
        </select>
      </label>
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

// ---- mixed lists ---------------------------------------------------------------------------

function ItemRow({ type, item, siblings }: { type: string; item: Hub["items"][number]; siblings: Hub["items"] }) {
  const go = useNav((s) => s.go);
  if (type === "track") {
    const t = item as Track;
    const tracks = siblings as Track[];
    return (
      <Row
        thumb={t.thumb}
        title={t.title}
        sub={`Song · ${t.artist}`}
        onClick={() => void player.playTracks(tracks, tracks.indexOf(t))}
        onMenu={(e) => openMenu(e, trackMenu([t], {}))}
      />
    );
  }
  if (type === "artist") {
    const a = item as Artist;
    return <Row thumb={a.thumb} round title={a.title} sub="Artist" onClick={() => go({ kind: "artist", id: a.ratingKey })} />;
  }
  if (type === "playlist") {
    const p = item as Playlist;
    return <Row thumb={p.thumb} title={p.title} sub="Playlist" onClick={() => go({ kind: "playlist", id: p.ratingKey })} />;
  }
  const a = item as Album;
  return (
    <Row
      thumb={a.thumb}
      title={a.title}
      sub={`Album · ${a.artist}`}
      onClick={() => go({ kind: "album", id: a.ratingKey })}
      onMenu={(e) => openMenu(e, albumMenu(a))}
    />
  );
}

/** A long list of one kind of item, drawn a screenful at a time. */
export function ItemRows({ type, items }: { type: string; items: Hub["items"] }) {
  const { limit, sentinel } = useProgressive(items.length);
  return (
    <div className="lrows">
      {items.slice(0, limit).map((it) => (
        <ItemRow key={it.ratingKey} type={type} item={it} siblings={items} />
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
      {sorted.map((h) => {
        const shown = h.type === "track" ? 6 : SEARCH_LIMIT;
        const title = `${h.title} for “${q.trim()}”`;
        return (
          <section key={h.hubIdentifier} className="phone-section">
            <div className="shelf-head section-head">
              <h2>{h.title}</h2>
              {h.items.length >= Math.min(shown + 1, SEARCH_LIMIT) && (
                <button className="link" onClick={() => go({ kind: "shelf", title, itemType: h.type, hub: h.hubIdentifier, search: q.trim() })}>
                  Show all <ChevronRight size={14} />
                </button>
              )}
            </div>
            <div className="lrows">
              {h.items.slice(0, shown).map((it) => (
                <ItemRow key={it.ratingKey} type={h.type} item={it} siblings={h.items} />
              ))}
            </div>
          </section>
        );
      })}
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
