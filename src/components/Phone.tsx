// Phone layout: bottom tabs, a compact mini player and full-screen Now Playing, in the spirit of
// the big streaming apps. Used on Android and in very narrow windows.
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown, Heart, Home, Library, ListMusic, Mic2, Pause, Play, Search, Settings, X,
} from "lucide-react";
import { Album, Artist, Hub, Playlist, Track } from "../plex";
import { player, usePlayer } from "../player";
import { openMenu, sectionKey, server, useNav, View } from "../store";
import { albumMenu, playAlbum, trackMenu, useData, usePaged, usePlaylists } from "../actions";
import { useRemote } from "../remote";
import { Cover, Heart_, Loading } from "./common";
import { SeekBar, Transport, usePlayhead } from "./PlayerBar";
import { LyricsView, QueueList } from "./Panels";
import { DevicesButton, ElsewhereBar, useDevicesSheet } from "./Devices";

// ---- tabs -------------------------------------------------------------------------------

const TABS: [View["kind"], string, typeof Home, View][] = [
  ["home", "Home", Home, { kind: "home" }],
  ["search", "Search", Search, { kind: "search" }],
  ["library", "Your Library", Library, { kind: "library" }],
];

/** Which tab a view belongs to. */
function tabOf(v: View) {
  if (v.kind === "home" || v.kind === "search") return v.kind;
  return "library";
}

export function PhoneNav() {
  const cur = useNav((s) => s.stack[s.stack.length - 1]);
  const go = useNav((s) => s.go);
  const tab = tabOf(cur);
  return (
    <nav className="phone-nav">
      {TABS.map(([kind, label, Icon, view]) => (
        <button
          key={kind}
          className={tab === kind ? "on" : ""}
          onClick={() => {
            // Tapping the current tab again returns to its top level.
            if (tab === kind) useNav.setState((s) => ({ stack: [...s.stack.filter((v) => tabOf(v) !== kind), view], forward: [] }));
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
  return (
    <div className="phone-bar-wrap">
      <ElsewhereBar />
      {track && (
        <div className="phone-bar" onClick={() => setNowPlaying(true)}>
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
  useEffect(() => {
    if (!nowPlaying) setPane("art");
  }, [nowPlaying]);
  if (!nowPlaying) return null;
  const bg = track ? server().imageUrl(track.thumb, 400) : undefined;
  const goTo = (v: View) => {
    setNowPlaying(false);
    go(v);
  };
  return (
    <div className="pnp">
      {bg && <div className="np-bg" style={{ backgroundImage: `url("${bg}")` }} />}
      <div className="np-shade" />
      <header className="pnp-head">
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
      <div className="pnp-body">
        {pane === "art" ? (
          <Cover thumb={track?.thumb} className="pnp-art" icon="album" />
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
