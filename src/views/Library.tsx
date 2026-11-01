import { useMemo, useRef, useState } from "react";
import { Heart, Plus, Search, Shuffle, Sparkles } from "lucide-react";
import { Album, Artist, Playlist, Track } from "../plex";
import { player } from "../player";
import { sectionKey, server, toast, useNav, useSession } from "../store";
import { prompt, useData, usePaged, usePlaylists, invalidate } from "../actions";
import { AlbumCard, ArtistCard, ErrorBox, Loading, PlaylistCard, Shelf } from "../components/common";
import { PageHead, RecentTiles } from "../components/Phone";
import { useIsPhone } from "../platform";

// ---- home ------------------------------------------------------------------------

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? "Up late" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

export function Home() {
  const sec = sectionKey();
  const user = useSession((s) => s.user);
  const hubs = useData(`hubs:${sec}`, () => server().hubs(sec));
  const random = useData(`random:${sec}`, () => server().randomAlbums(sec, 16));
  const go = useNav((s) => s.go);
  const phone = useIsPhone();
  const shelves = (
    <>
      {hubs.data?.map((h) => (
        <Shelf key={h.hubIdentifier} title={h.title}>
          {h.items.map((it) =>
            h.itemType === "artist" ? (
              <ArtistCard key={it.ratingKey} a={it as Artist} />
            ) : h.itemType === "playlist" ? (
              <PlaylistCard key={it.ratingKey} p={it as Playlist} />
            ) : h.itemType === "track" ? (
              <TrackCard key={it.ratingKey} t={it as Track} />
            ) : (
              <AlbumCard key={it.ratingKey} a={it as Album} />
            ),
          )}
        </Shelf>
      ))}
      {random.data && random.data.length > 0 && (
        <Shelf title="Rediscover" onMore={random.reload}>
          {random.data.map((a) => (
            <AlbumCard key={a.ratingKey} a={a} />
          ))}
        </Shelf>
      )}
    </>
  );

  if (phone)
    return (
      <div className="view phone-view">
        <PageHead title={`${greeting()}${user?.title ? `, ${user.title.split(" ")[0]}` : ""}`} />
        <div className="chips phone-chips">
          <button className="chip" onClick={() => player.shuffleLibrary()}>
            <Shuffle size={14} /> Shuffle library
          </button>
          <button className="chip" onClick={() => go({ kind: "playlist", id: "loved" })}>
            <Heart size={14} /> Loved
          </button>
        </div>
        <RecentTiles />
        {hubs.error && <ErrorBox error={hubs.error} retry={hubs.reload} />}
        {hubs.loading && <Loading />}
        {shelves}
      </div>
    );
  return (
    <div className="view">
      <header className="home-head">
        <h1>
          {greeting()}
          {user?.title ? `, ${user.title.split(" ")[0]}` : ""}
        </h1>
        <div className="row gap">
          <button className="btn primary" onClick={() => player.shuffleLibrary()}>
            <Shuffle size={16} /> Shuffle library
          </button>
          <button className="btn" onClick={() => go({ kind: "playlist", id: "loved" })}>
            <Heart size={16} /> Loved tracks
          </button>
          <button className="btn" onClick={() => useNav.getState().setPalette(true)}>
            <Search size={16} /> Search <kbd>Ctrl K</kbd>
          </button>
        </div>
      </header>
      {hubs.error && <ErrorBox error={hubs.error} retry={hubs.reload} />}
      {hubs.loading && <Loading />}
      {shelves}
    </div>
  );
}

function TrackCard({ t }: { t: Track }) {
  const a: Album = { ratingKey: t.albumKey ?? t.ratingKey, title: t.title, artist: t.artist, artistKey: t.artistKey, thumb: t.thumb };
  return (
    <div onDoubleClick={() => player.playTracks([t])}>
      <AlbumCard a={a} sub={t.artist} />
    </div>
  );
}

// ---- grid helpers -------------------------------------------------------------------

function useFilter<T extends { title: string }>(items: T[], extra?: (t: T) => string) {
  const [q, setQ] = useState("");
  const filtered = useMemo(() => {
    const n = q.toLowerCase().trim();
    if (!n) return items;
    return items.filter((x) => x.title.toLowerCase().includes(n) || (extra && extra(x).toLowerCase().includes(n)));
  }, [items, q, extra]);
  return { q, setQ, filtered };
}

function FilterBox({ q, setQ, placeholder }: { q: string; setQ: (v: string) => void; placeholder: string }) {
  return (
    <div className="filter">
      <Search size={15} />
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={placeholder} onKeyDown={(e) => e.key === "Escape" && setQ("")} />
    </div>
  );
}

const LETTERS = "#ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");

function letterOf(title: string) {
  const c = title
    .replace(/^the\s+/i, "")
    .normalize("NFD")
    .charAt(0)
    .toUpperCase();
  return c >= "A" && c <= "Z" ? c : "#";
}

function JumpBar({ onJump, available }: { onJump: (l: string) => void; available: Set<string> }) {
  return (
    <div className="jumpbar">
      {LETTERS.map((l) => (
        <button key={l} disabled={!available.has(l)} onClick={() => onJump(l)}>
          {l}
        </button>
      ))}
    </div>
  );
}

// ---- artists ----------------------------------------------------------------------

const ARTIST_SORTS: [string, string][] = [
  ["titleSort", "Name"],
  ["addedAt:desc", "Recently added"],
  ["lastViewedAt:desc", "Recently played"],
  ["viewCount:desc", "Most played"],
];

export function Artists() {
  const sec = sectionKey();
  const [sort, setSort] = useState(() => localStorage.getItem("tonearm.artistSort") ?? "titleSort");
  const { items, total, done } = usePaged(`artists:${sec}:${sort}`, (s, n) => server().artists(sec, sort, s, n));
  const { q, setQ, filtered } = useFilter(items);
  const gridRef = useRef<HTMLDivElement>(null);
  const letters = useMemo(() => new Set(filtered.map((a) => letterOf(a.title))), [filtered]);

  return (
    <div className="view">
      <header className="view-head">
        <h1>Artists</h1>
        <span className="dim">{total ? `${total.toLocaleString()} artists` : ""}</span>
        <div className="grow" />
        <FilterBox q={q} setQ={setQ} placeholder="Filter artists" />
        <select
          value={sort}
          onChange={(e) => {
            setSort(e.target.value);
            localStorage.setItem("tonearm.artistSort", e.target.value);
          }}
        >
          {ARTIST_SORTS.map(([k, l]) => (
            <option key={k} value={k}>
              {l}
            </option>
          ))}
        </select>
      </header>
      {sort === "titleSort" && !q && (
        <JumpBar
          available={letters}
          onJump={(l) => {
            const i = filtered.findIndex((a) => letterOf(a.title) === l);
            (gridRef.current?.children[i] as HTMLElement | undefined)?.scrollIntoView({ block: "start", behavior: "smooth" });
          }}
        />
      )}
      {!items.length && !done && <Loading />}
      <div className="grid" ref={gridRef}>
        {filtered.map((a) => (
          <ArtistCard key={a.ratingKey} a={a} />
        ))}
      </div>
      {!done && items.length > 0 && <Loading label={`Loaded ${items.length} of ${total}…`} />}
    </div>
  );
}

// ---- albums -----------------------------------------------------------------------

const ALBUM_SORTS: [string, string][] = [
  ["titleSort", "Title"],
  ["artist.titleSort,album.year", "Artist"],
  ["year:desc", "Release year"],
  ["addedAt:desc", "Recently added"],
  ["lastViewedAt:desc", "Recently played"],
  ["viewCount:desc", "Most played"],
  ["userRating:desc", "Rating"],
  ["random", "Random"],
];

export function Albums({ genre: initialGenre }: { genre?: string }) {
  const sec = sectionKey();
  const [sort, setSort] = useState(() => localStorage.getItem("tonearm.albumSort") ?? "addedAt:desc");
  const [genre, setGenre] = useState(initialGenre ?? "");
  const [unplayed, setUnplayed] = useState(false);
  const genres = useData(`genres:${sec}`, () => server().genres(sec));
  const { items, total, done } = usePaged(`albums:${sec}:${sort}:${genre}:${unplayed}`, (s, n) =>
    server().albums(sec, { sort, genre: genre || undefined, unplayed }, s, n),
  );
  const { q, setQ, filtered } = useFilter(items, (a) => a.artist);

  return (
    <div className="view">
      <header className="view-head">
        <h1>Albums</h1>
        <span className="dim">{total ? `${total.toLocaleString()} albums` : ""}</span>
        <div className="grow" />
        <FilterBox q={q} setQ={setQ} placeholder="Filter albums or artists" />
        <label className="check">
          <input type="checkbox" checked={unplayed} onChange={(e) => setUnplayed(e.target.checked)} /> Never played
        </label>
        <select value={genre} onChange={(e) => setGenre(e.target.value)}>
          <option value="">All genres</option>
          {genres.data?.map((g) => (
            <option key={g.key} value={g.key}>
              {g.title}
            </option>
          ))}
        </select>
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
      </header>
      {!items.length && !done && <Loading />}
      {done && !items.length && <p className="dim pad">No albums match.</p>}
      <div className="grid">
        {filtered.map((a) => (
          <AlbumCard key={a.ratingKey} a={a} />
        ))}
      </div>
      {!done && items.length > 0 && <Loading label={`Loaded ${items.length} of ${total}…`} />}
    </div>
  );
}

// ---- playlists ------------------------------------------------------------------------

export function Playlists() {
  const pl = useData("playlists", () => server().playlists());
  const go = useNav((s) => s.go);
  const loved: Playlist = { ratingKey: "loved", title: "Loved tracks", leafCount: 0, duration: 0, smart: true };
  return (
    <div className="view">
      <header className="view-head">
        <h1>Playlists</h1>
        <div className="grow" />
        <button
          className="btn"
          onClick={async () => {
            const name = await prompt("New playlist name");
            if (!name) return;
            try {
              const p = await server().createPlaylist(name, []);
              invalidate("playlists");
              usePlaylists.getState().refresh();
              go({ kind: "playlist", id: p.ratingKey });
            } catch (e) {
              toast(`Couldn't create playlist: ${e}`, { error: true });
            }
          }}
        >
          <Plus size={16} /> New playlist
        </button>
      </header>
      {pl.error && <ErrorBox error={pl.error} retry={pl.reload} />}
      {pl.loading && <Loading />}
      <div className="grid">
        <div className="card" onClick={() => go({ kind: "playlist", id: "loved" })}>
          <div className="card-art">
            <div className="cover loved-cover">
              <Heart size={48} fill="currentColor" />
            </div>
          </div>
          <div className="card-title">{loved.title}</div>
          <div className="card-sub">Auto playlist</div>
        </div>
        <div className="card" onClick={() => player.shuffleLibrary()}>
          <div className="card-art">
            <div className="cover mix-cover">
              <Sparkles size={48} />
            </div>
          </div>
          <div className="card-title">Library shuffle</div>
          <div className="card-sub">300 random tracks</div>
        </div>
        {pl.data?.map((p) => (
          <PlaylistCard key={p.ratingKey} p={p} />
        ))}
      </div>
    </div>
  );
}
