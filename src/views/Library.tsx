import { useMemo, useRef, useState } from "react";
import { Heart, Plus, RefreshCw, Search, Shuffle, Sparkles } from "lucide-react";
import { Album, Artist, Hub, Playlist, Track } from "../plex";
import { player } from "../player";
import { loadJson, sectionKey, server, toast, useNav, useSession, View } from "../store";
import { ALBUM_SORTS, prompt, useData, usePaged, usePlaylists, invalidate } from "../actions";
import { AlbumCard, ArtistCard, ErrorBox, Loading, PlaylistCard, Shelf, TrackList } from "../components/common";
import { ItemRows, PageHead, RecentTiles } from "../components/Phone";
import { MIX_IDS, MIX_LABEL, MixId, getMix, periodOf } from "../mixes";
import { MixCover } from "../components/MixCover";
import { useIsPhone } from "../platform";

// ---- home ------------------------------------------------------------------------

/** How long Rediscover keeps the same albums, across visits and restarts. */
const REDISCOVER_MS = 60 * 60_000;

/** Random albums for Rediscover, kept for an hour unless `fresh`. */
async function rediscover(sec: string, fresh: boolean): Promise<Album[]> {
  const key = `tonearm.rediscover.${sec}`;
  const saved = loadJson<{ at: number; items: Album[] } | null>(key, null);
  if (!fresh && saved?.items?.length && Date.now() - saved.at < REDISCOVER_MS) return saved.items;
  const items = await server().randomAlbums(sec, 16);
  try {
    localStorage.setItem(key, JSON.stringify({ at: Date.now(), items }));
  } catch {
    /* shown anyway, just not kept */
  }
  return items;
}

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? "Up late" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

export function Home() {
  const sec = sectionKey();
  const user = useSession((s) => s.user);
  const hubs = useData(`hubs:${sec}`, () => server().hubs(sec));
  // Only the refresh button asks for different albums; coming back to Home keeps them.
  const freshRandom = useRef(false);
  const random = useData(`random:${sec}`, () => rediscover(sec, freshRandom.current).finally(() => (freshRandom.current = false)));
  const go = useNav((s) => s.go);
  const phone = useIsPhone();
  const shelves = (
    <>
      <Shelf title="Made for you" complete>
        {MIX_IDS.map((id) => (
          <MixCard key={id} id={id} />
        ))}
      </Shelf>
      {hubs.data?.map((h) => (
        <Shelf key={h.hubIdentifier} title={h.title} complete={!h.more} onMore={() => go(hubView(h))}>
          {h.items.map((it) => (
            <HubCard key={it.ratingKey} item={it} itemType={h.itemType} />
          ))}
        </Shelf>
      ))}
      {random.data && random.data.length > 0 && (
        <Shelf
          title="Rediscover"
          onMore={() => go({ kind: "shelf", title: "Rediscover", itemType: "album", path: `/library/sections/${sec}/all?type=9&sort=random` })}
          actions={
            <button
              className="icon-btn shelf-action"
              title="Show different albums"
              onClick={() => {
                freshRandom.current = true;
                random.reload();
              }}
            >
              <RefreshCw size={16} />
            </button>
          }
        >
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

/** A playlist Platter makes for you (see mixes.ts). Made in the background when Home opens. */
function MixCard({ id }: { id: MixId }) {
  const go = useNav((s) => s.go);
  const mix = useData(`mix:${id}:${periodOf(id)}`, () => getMix(id));
  const label = MIX_LABEL[id];
  // The newer mixes need enough listening (or new music) to make; until then they stay out of the way.
  const core = id === "daylist" || id === "suggestions";
  if (!core && (mix.error || mix.data?.tracks.length === 0)) return null;
  return (
    <div className="card" onClick={() => go({ kind: "playlist", id })}>
      <div className="card-art">
        <MixCover id={id} mix={mix.data} />
      </div>
      <div className="card-title">{mix.data?.title ?? label}</div>
      <div className="card-sub">{mix.error
          ? "Couldn't make it this time"
          : mix.data
            ? id.startsWith("daily")
              ? mix.data.subtitle
              : `${mix.data.tracks.length} tracks`
            : "Putting it together…"}</div>
    </div>
  );
}

function HubCard({ item, itemType }: { item: Hub["items"][number]; itemType: string }) {
  if (itemType === "artist") return <ArtistCard a={item as Artist} />;
  if (itemType === "playlist") return <PlaylistCard p={item as Playlist} />;
  if (itemType === "track") return <TrackCard t={item as Track} />;
  return <AlbumCard a={item as Album} />;
}

function hubView(h: Hub): View {
  if (h.hubIdentifier === "local-albums") return { kind: "local" };
  return { kind: "shelf", title: h.title, itemType: h.itemType, path: h.path, hub: h.hubIdentifier };
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

// ---- show all -------------------------------------------------------------------------

export function ShelfView({ v }: { v: Extract<View, { kind: "shelf" }> }) {
  const sec = sectionKey();
  const phone = useIsPhone();
  const { items: listed, done } = usePaged<Hub["items"][number]>(`shelf:${sec}:${v.path ?? ""}:${v.hub ?? ""}:${v.search ?? ""}`, async (start, size) => {
    if (v.search) {
      const items = (await server().search(sec, v.search, 200)).find((h) => h.hubIdentifier === v.hub)?.items ?? [];
      return { items, total: items.length };
    }
    if (!v.path) return { items: [], total: 0 };
    // A random order differs on every request, so paging through it would repeat and miss albums.
    return server().hubItems(v.path, start, v.path.includes("sort=random") ? 1_000_000 : size);
  });
  // A hub whose full listing can't be read still has the items it came with.
  const hubs = useData(v.hub && !v.search ? `hubs:${sec}` : null, () => server().hubs(sec));
  const items = useMemo(() => {
    if (listed.length || !done) return listed;
    return hubs.data?.find((h) => h.hubIdentifier === v.hub)?.items ?? [];
  }, [listed, done, hubs.data, v.hub]);
  const { q, setQ, filtered } = useFilter(items, (x) => `${(x as Album).artist ?? ""} ${(x as Track).album ?? ""}`);
  const empty = done && !items.length && <p className="dim pad">Nothing here.</p>;
  const loading = !items.length && !done && <Loading />;
  const filter = items.length > 1 && <FilterBox q={q} setQ={setQ} placeholder="Filter" />;

  if (phone)
    return (
      <div className="view phone-view">
        <PageHead title={v.title} />
        <div className="shelf-filter">{filter}</div>
        {loading}
        {empty}
        <ItemRows type={v.itemType} items={filtered} />
      </div>
    );
  return (
    <div className="view">
      <header className="view-head">
        <h1>{v.title}</h1>
        <span className="dim">{items.length ? `${items.length.toLocaleString()} ${items.length === 1 ? "item" : "items"}` : ""}</span>
        <div className="grow" />
        {filter}
      </header>
      {loading}
      {empty}
      {v.itemType === "track" ? (
        <TrackList tracks={filtered as Track[]} showAlbum showArtist showCover numbered="position" />
      ) : (
        <div className="grid">
          {filtered.map((it) => (
            <HubCard key={it.ratingKey} item={it} itemType={v.itemType} />
          ))}
        </div>
      )}
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

export function Albums({ genre: initialGenre }: { genre?: string }) {
  const sec = sectionKey();
  const [sort, setSort] = useState(() => localStorage.getItem("tonearm.albumSort") ?? "titleSort");
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
