import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Disc3, Heart, Music, Play, User, X } from "lucide-react";
import { Album, Artist, Playlist, Track } from "../plex";
import { player, usePlayer } from "../player";
import { MenuItem, fmtTime, openMenu, server, useMenu, useNav, useToasts } from "../store";
import { isAndroid, isPhone } from "../platform";
import { attachShelfWheel, pageStride, smoothScrollBy } from "../smooth";
import { albumMenu, playAlbum, playArtist, setLoved, trackMenu, usePrompt, useRatings } from "../actions";

// ---- artwork -----------------------------------------------------------------

// One observer for every cover on screen.
const widthCallbacks = new WeakMap<Element, (width: number) => void>();
let coverObserver: ResizeObserver | null = null;

function observeWidth(el: Element, cb: (width: number) => void) {
  coverObserver ??= new ResizeObserver((entries) => {
    for (const e of entries) widthCallbacks.get(e.target)?.(e.contentRect.width);
  });
  widthCallbacks.set(el, cb);
  coverObserver.observe(el);
  return () => {
    coverObserver?.unobserve(el);
    widthCallbacks.delete(el);
  };
}

/**
 * Artwork fetched at exactly the size it's drawn. Scaling images while scrolling is what drops
 * frames in WebKitGTK, so when the cover spans a whole number of device pixels the image is
 * drawn 1:1 with no filtering at all; otherwise it's fetched a little larger and scaled down.
 */
export function Cover({ thumb, round, className = "", icon }: { thumb?: string; round?: boolean; className?: string; icon?: "artist" | "album" }) {
  const [failed, setFailed] = useState(false);
  const [width, setWidth] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => observeWidth(ref.current!, setWidth), []);
  useEffect(() => setFailed(false), [thumb]);
  const device = width * (window.devicePixelRatio || 1);
  const exact = device > 0 && Math.abs(device - Math.round(device)) < 0.01;
  const fetchSize = exact ? Math.round(device) : Math.ceil(device / 100) * 100;
  const url = !failed && fetchSize ? server().imageUrl(thumb, fetchSize) : undefined;
  const Fallback = icon === "artist" ? User : icon === "album" ? Disc3 : Music;
  return (
    <div ref={ref} className={`cover ${round ? "round" : ""} ${className}`}>
      {url ? (
        <img src={url} className={exact ? "exact" : ""} loading="lazy" decoding="async" draggable={false} onError={() => setFailed(true)} alt="" />
      ) : (
        !thumb || failed ? <Fallback className="cover-fallback" /> : null
      )}
    </div>
  );
}

// ---- cards / grids -------------------------------------------------------------

export const AlbumCard = memo(function AlbumCard({ a, sub }: { a: Album; sub?: string }) {
  const go = useNav((s) => s.go);
  return (
    <div className="card" onClick={() => go({ kind: "album", id: a.ratingKey })} onContextMenu={(e) => openMenu(e, albumMenu(a))}>
      <div className="card-art">
        <Cover thumb={a.thumb} icon="album" />
        <button
          className="card-play"
          title="Play"
          onClick={(e) => {
            e.stopPropagation();
            playAlbum(a.ratingKey);
          }}
        >
          <Play size={18} fill="currentColor" />
        </button>
      </div>
      <div className="card-title" title={a.title}>
        {a.title}
      </div>
      <div className="card-sub">{sub ?? [a.artist, a.year].filter(Boolean).join(" · ")}</div>
    </div>
  );
});

export const ArtistCard = memo(function ArtistCard({ a }: { a: Artist }) {
  const go = useNav((s) => s.go);
  return (
    <div
      className="card"
      onClick={() => go({ kind: "artist", id: a.ratingKey })}
      onContextMenu={(e) =>
        openMenu(e, [
          { label: "Shuffle artist", run: () => playArtist(a.ratingKey, true) },
          { label: "Play all in order", run: () => playArtist(a.ratingKey, false) },
        ])
      }
    >
      <div className="card-art">
        <Cover thumb={a.thumb} round icon="artist" />
        <button
          className="card-play"
          title="Shuffle artist"
          onClick={(e) => {
            e.stopPropagation();
            playArtist(a.ratingKey);
          }}
        >
          <Play size={18} fill="currentColor" />
        </button>
      </div>
      <div className="card-title center" title={a.title}>
        {a.title}
      </div>
      <div className="card-sub center">Artist</div>
    </div>
  );
});

export const PlaylistCard = memo(function PlaylistCard({ p }: { p: Playlist }) {
  const go = useNav((s) => s.go);
  return (
    <div className="card" onClick={() => go({ kind: "playlist", id: p.ratingKey })}>
      <div className="card-art">
        <Cover thumb={p.thumb} />
        <button
          className="card-play"
          title="Play"
          onClick={async (e) => {
            e.stopPropagation();
            player.playTracks(await server().playlistTracks(p.ratingKey));
          }}
        >
          <Play size={18} fill="currentColor" />
        </button>
      </div>
      <div className="card-title">{p.title}</div>
      <div className="card-sub">
        {p.smart ? "Smart · " : ""}
        {p.leafCount} tracks
      </div>
    </div>
  );
});

export function Shelf({ title, children, onMore }: { title: string; children: React.ReactNode; onMore?: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [ends, setEnds] = useState({ start: true, end: true });
  useEffect(() => {
    const el = ref.current!;
    const update = () => {
      const max = el.scrollWidth - el.clientWidth;
      setEnds((p) => {
        const n = { start: el.scrollLeft <= 1, end: el.scrollLeft >= max - 1 };
        return p.start === n.start && p.end === n.end ? p : n;
      });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    el.addEventListener("scroll", update, { passive: true });
    const detach = attachShelfWheel(el);
    return () => {
      ro.disconnect();
      el.removeEventListener("scroll", update);
      detach();
    };
  }, []);
  const page = (dir: number) => ref.current && smoothScrollBy(ref.current, dir * pageStride(ref.current));
  return (
    <section className="shelf">
      <div className="shelf-head">
        <h2>{title}</h2>
        <div className="shelf-nav">
          {onMore && (
            <button className="link" onClick={onMore}>
              Show all <ChevronRight size={14} />
            </button>
          )}
          {!(ends.start && ends.end) && (
            <>
              <button className="icon-btn" disabled={ends.start} onClick={() => page(-1)} title="Scroll left">
                <ChevronLeft size={18} />
              </button>
              <button className="icon-btn" disabled={ends.end} onClick={() => page(1)} title="Scroll right">
                <ChevronRight size={18} />
              </button>
            </>
          )}
        </div>
      </div>
      <div className="shelf-row" ref={ref}>
        {children}
      </div>
    </section>
  );
}

// ---- track list -------------------------------------------------------------------

export function Heart_({ t }: { t: Track }) {
  const override = useRatings((s) => s[t.ratingKey]);
  const loved = (override !== undefined ? override : t.userRating ?? null) === 10;
  return (
    <button
      className={`icon-btn heart ${loved ? "on" : ""}`}
      title={loved ? "Unlove" : "Love"}
      onClick={(e) => {
        e.stopPropagation();
        setLoved(t, !loved);
      }}
    >
      <Heart size={15} fill={loved ? "currentColor" : "none"} />
    </button>
  );
}

export function PlayingBars({ paused }: { paused: boolean }) {
  return (
    <span className={`bars ${paused ? "paused" : ""}`}>
      <i />
      <i />
      <i />
    </span>
  );
}

interface TrackListProps {
  tracks: Track[];
  showAlbum?: boolean;
  showArtist?: boolean | "auto";
  showCover?: boolean;
  numbered?: "index" | "position";
  discs?: boolean;
  playlistId?: string;
  onRemoved?: () => void;
}

export function TrackList({ tracks, showAlbum, showArtist = "auto", showCover, numbered = "index", discs, playlistId, onRemoved }: TrackListProps) {
  const current = usePlayer((s) => s.queue[s.index]?.track.ratingKey);
  const loaded = usePlayer((s) => s.loaded);
  const paused = usePlayer((s) => s.paused);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const anchor = useRef<number | null>(null);
  useRatings(); // re-render on rating changes
  const mainArtist = tracks.length ? mostCommon(tracks.map((t) => t.artist)) : "";
  const multiDisc = discs && new Set(tracks.map((t) => t.disc ?? 1)).size > 1;

  const select = (i: number, e: React.MouseEvent) => {
    if (e.shiftKey && anchor.current !== null) {
      const [a, b] = [Math.min(anchor.current, i), Math.max(anchor.current, i)];
      setSelected(new Set(Array.from({ length: b - a + 1 }, (_, k) => a + k)));
    } else if (e.ctrlKey || e.metaKey) {
      const s = new Set(selected);
      s.has(i) ? s.delete(i) : s.add(i);
      setSelected(s);
      anchor.current = i;
    } else {
      setSelected(new Set([i]));
      anchor.current = i;
    }
  };

  const rows: React.ReactNode[] = [];
  let lastDisc: number | undefined;
  tracks.forEach((t, i) => {
    if (multiDisc && t.disc !== lastDisc) {
      lastDisc = t.disc;
      rows.push(
        <div className="disc-head" key={`disc-${t.disc}-${i}`}>
          <Disc3 size={15} /> Disc {t.disc ?? 1}
        </div>,
      );
    }
    const isCur = current === t.ratingKey && loaded;
    const artistShown = showArtist === true || (showArtist === "auto" && t.artist !== mainArtist);
    rows.push(
      <div
        key={`${t.ratingKey}-${i}`}
        className={`track ${isCur ? "current" : ""} ${selected.has(i) ? "selected" : ""}`}
        onClick={(e) => (isAndroid() ? player.playTracks(tracks, i) : select(i, e))}
        onDoubleClick={() => player.playTracks(tracks, i)}
        onContextMenu={(e) => {
          const sel = selected.has(i) ? [...selected].sort((a, b) => a - b).map((k) => tracks[k]) : [t];
          if (!selected.has(i)) setSelected(new Set([i]));
          openMenu(e, trackMenu(sel, { playAll: tracks, index: i, playlistId, onRemoved }));
        }}
      >
        <div className="track-num">
          {isCur ? <PlayingBars paused={paused} /> : <span className="num">{numbered === "index" ? t.index ?? i + 1 : i + 1}</span>}
          <button className="row-play" onClick={(e) => (e.stopPropagation(), player.playTracks(tracks, i))} title="Play">
            <Play size={14} fill="currentColor" />
          </button>
        </div>
        {showCover && <Cover thumb={t.thumb} className="track-cover" />}
        <div className="track-main">
          <div className="track-title">{t.title}</div>
          {artistShown && <ArtistLink t={t} />}
        </div>
        {showAlbum && <AlbumLink t={t} />}
        <Heart_ t={t} />
        <div className="track-dur">{fmtTime(t.duration / 1000)}</div>
        <button
          className="icon-btn more"
          onClick={(e) => openMenu(e, trackMenu([t], { playAll: tracks, index: i, playlistId, onRemoved }))}
          title="More"
        >
          ⋯
        </button>
      </div>,
    );
  });
  return <div className="tracklist">{rows}</div>;
}

function ArtistLink({ t }: { t: Track }) {
  const go = useNav((s) => s.go);
  return (
    <div
      className="track-sub link-text"
      onClick={(e) => {
        if (!t.artistKey) return;
        e.stopPropagation();
        go({ kind: "artist", id: t.artistKey });
      }}
    >
      {t.artist}
    </div>
  );
}

function AlbumLink({ t }: { t: Track }) {
  const go = useNav((s) => s.go);
  return (
    <div
      className="track-album link-text"
      onClick={(e) => {
        if (!t.albumKey) return;
        e.stopPropagation();
        go({ kind: "album", id: t.albumKey });
      }}
    >
      {t.album}
    </div>
  );
}

function mostCommon(xs: string[]) {
  const m = new Map<string, number>();
  xs.forEach((x) => m.set(x, (m.get(x) ?? 0) + 1));
  return [...m.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
}

// ---- overlays -----------------------------------------------------------------

function MenuList({ items, x, y, onClose }: { items: MenuItem[]; x: number; y: number; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  const [sub, setSub] = useState<{ i: number; x: number; y: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      x: x + r.width > window.innerWidth ? Math.max(4, x - r.width) : x,
      y: y + r.height > window.innerHeight ? Math.max(4, window.innerHeight - r.height - 4) : y,
    });
  }, [x, y]);
  return (
    <div className="menu" ref={ref} style={{ left: pos.x, top: pos.y }} onContextMenu={(e) => e.preventDefault()}>
      {items.map((it, i) =>
        it.separator ? (
          <div className="menu-sep" key={i} />
        ) : (
          <div
            key={i}
            className={`menu-item ${it.danger ? "danger" : ""} ${it.disabled ? "disabled" : ""}`}
            onMouseEnter={(e) => {
              if (isPhone()) return;
              if (it.submenu) {
                const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                setSub({ i, x: r.right - 2, y: r.top - 4 });
              } else setSub(null);
            }}
            onClick={() => {
              if (it.disabled) return;
              // Touch screens drill into submenus in place.
              if (it.submenu) {
                if (isPhone()) useMenu.setState({ items: it.submenu });
                return;
              }
              onClose();
              it.run?.();
            }}
          >
            <span className="menu-icon">{it.icon}</span>
            <span className="menu-label">{it.label}</span>
            {it.submenu && <ChevronRight size={14} />}
          </div>
        ),
      )}
      {sub && items[sub.i]?.submenu && (
        <MenuList items={items[sub.i].submenu!} x={sub.x} y={sub.y} onClose={onClose} />
      )}
    </div>
  );
}

export function ContextMenu() {
  const { items, x, y, close } = useMenu();
  useEffect(() => {
    if (!items) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [items, close]);
  if (!items) return null;
  return (
    <div className="menu-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()} onContextMenu={(e) => (e.preventDefault(), close())}>
      <MenuList items={items} x={x} y={y} onClose={close} />
    </div>
  );
}

export function Toasts() {
  const { toasts, dismiss } = useToasts();
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.error ? "error" : ""}`}>
          <span>{t.text}</span>
          {t.action && (
            <button
              className="toast-action"
              onClick={() => {
                t.action!.run();
                dismiss(t.id);
              }}
            >
              {t.action.label}
            </button>
          )}
          <button className="icon-btn" onClick={() => dismiss(t.id)}>
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}

export function PromptModal() {
  const { title, value, confirm, resolve } = usePrompt();
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value, resolve]);
  if (!resolve) return null;
  const done = (r: string | null) => {
    usePrompt.setState({ resolve: null });
    resolve(r);
  };
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && done(null)}>
      <form
        className="modal"
        onSubmit={(e) => {
          e.preventDefault();
          done(confirm ? "ok" : v.trim() || null);
        }}
      >
        <h3>{title}</h3>
        {!confirm && <input autoFocus value={v} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => e.key === "Escape" && done(null)} />}
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={() => done(null)}>
            Cancel
          </button>
          <button type="submit" className="btn primary" autoFocus={confirm}>
            {confirm ? "Delete" : "OK"}
          </button>
        </div>
      </form>
    </div>
  );
}

export const SHORTCUTS: [string, string][] = [
  ["Space", "Play / pause"],
  ["Ctrl + → / ←", "Next / previous track"],
  ["→ / ←", "Seek ±10 seconds"],
  ["↑ / ↓", "Volume up / down"],
  ["M", "Mute"],
  ["S", "Toggle shuffle"],
  ["R", "Cycle repeat (off → all → one)"],
  ["L", "Toggle lyrics panel"],
  ["Q", "Toggle queue panel"],
  ["F", "Full-screen now playing"],
  ["H", "Love / unlove current track"],
  ["Ctrl + K  or  /", "Search & command palette"],
  ["Ctrl + Shift + M", "Mini player"],
  ["Alt + ← / →", "Back / forward"],
  ["Ctrl + 1…5", "Home, Artists, Albums, Playlists, Queue"],
  ["Ctrl + ,", "Settings"],
  ["F5  /  Shift + F5", "Refresh library / rescan library folders"],
  ["Ctrl + = / − / 0", "Zoom in / out / reset"],
  ["?", "This help"],
];

export function HelpModal() {
  const { help, setHelp } = useNav();
  if (!help) return null;
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setHelp(false)}>
      <div className="modal wide">
        <h3>Keyboard shortcuts</h3>
        <div className="shortcuts">
          {SHORTCUTS.map(([k, d]) => (
            <div key={k} className="shortcut">
              <kbd>{k}</kbd>
              <span>{d}</span>
            </div>
          ))}
        </div>
        <p className="dim small">Media keys, desktop widgets and playerctl work via MPRIS. From a terminal: <code>platter --toggle | --next | --previous</code></p>
        <div className="modal-actions">
          <button className="btn primary" onClick={() => setHelp(false)}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="loading">
      <div className="spinner" />
      {label}
    </div>
  );
}

export function ErrorBox({ error, retry }: { error: string; retry?: () => void }) {
  return (
    <div className="error-box">
      <p>{error}</p>
      {retry && (
        <button className="btn" onClick={retry}>
          Retry
        </button>
      )}
    </div>
  );
}
