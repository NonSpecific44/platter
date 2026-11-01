import { useMemo, useState } from "react";
import { Heart, ListEnd, ListStart, MoreHorizontal, Pencil, Play, Radio, Search, Shuffle, Trash2 } from "lucide-react";
import { Album, Track, toTrack } from "../plex";
import { player } from "../player";
import { fmtDuration, openMenu, sectionKey, server, toast, useNav } from "../store";
import { albumMenu, confirmDialog, invalidate, playArtist, prompt, ratingOf, setLoved, trackRadio, useData, usePlaylists, useRatings } from "../actions";
import { AlbumCard, Cover, ErrorBox, Loading, Shelf, TrackList } from "../components/common";

function Hero({ thumb, round, kicker, title, children, art }: {
  thumb?: string;
  round?: boolean;
  kicker: string;
  title: string;
  children?: React.ReactNode;
  art?: string;
}) {
  const bg = art ? server().imageUrl(art, 1200) : undefined;
  return (
    <header className={`hero ${bg ? "has-art" : ""}`}>
      {bg && <div className="hero-bg" style={{ backgroundImage: `url("${bg}")` }} />}
      <Cover thumb={thumb} round={round} className="hero-cover" icon={round ? "artist" : "album"} />
      <div className="hero-text">
        <div className="kicker">{kicker}</div>
        <h1 title={title}>{title}</h1>
        {children}
      </div>
    </header>
  );
}

function Summary({ text }: { text?: string }) {
  const [open, setOpen] = useState(false);
  if (!text) return null;
  return (
    <p className={`summary ${open ? "open" : ""}`} onClick={() => setOpen(!open)} title={open ? "" : "Click to expand"}>
      {text}
    </p>
  );
}

// ---- artist ---------------------------------------------------------------------------

function groupAlbums(albums: Album[]) {
  const groups: Record<string, Album[]> = { Albums: [], "Singles & EPs": [], "Live & Compilations": [] };
  for (const a of albums) {
    const f = (a.format ?? "").toLowerCase();
    if (/single|ep/.test(f) || (!f && (a.leafCount ?? 99) <= 3)) groups["Singles & EPs"].push(a);
    else if (/live|compilation|soundtrack|remix|demo/.test(f)) groups["Live & Compilations"].push(a);
    else groups.Albums.push(a);
  }
  for (const g of Object.values(groups)) g.sort((a, b) => (b.year ?? 0) - (a.year ?? 0));
  return Object.entries(groups).filter(([, v]) => v.length);
}

export function ArtistView({ id }: { id: string }) {
  const artist = useData(`artist:${id}`, () => server().artist(id));
  const albums = useData(`artistAlbums:${id}`, () => server().artistAlbums(id));
  const popular = useData(`popular:${id}`, () => server().popularTracks(sectionKey(), id));
  const go = useNav((s) => s.go);
  const [showAllPopular, setShowAllPopular] = useState(false);

  if (artist.error) return <ErrorBox error={artist.error} retry={artist.reload} />;
  if (!artist.data) return <Loading />;
  const a = artist.data;

  const openSimilar = async (name: string) => {
    const hubs = await server().search(sectionKey(), name);
    const hit = hubs.find((h) => h.type === "artist")?.items.find((x) => x.title.toLowerCase() === name.toLowerCase());
    if (hit) go({ kind: "artist", id: hit.ratingKey });
    else toast(`${name} isn't in your library`);
  };

  return (
    <div className="view">
      <Hero thumb={a.thumb} round kicker="Artist" title={a.title} art={a.art}>
        {a.genres?.length ? <div className="dim">{a.genres.slice(0, 4).join(" · ")}</div> : null}
        <div className="hero-actions">
          <button className="btn primary" onClick={() => playArtist(id, true)}>
            <Shuffle size={16} /> Shuffle
          </button>
          <button className="btn" onClick={() => playArtist(id, false)}>
            <Play size={16} /> Play all
          </button>
          {popular.data?.[0] && (
            <button className="btn" onClick={() => trackRadio(popular.data![0])}>
              <Radio size={16} /> Radio
            </button>
          )}
        </div>
      </Hero>
      <Summary text={a.summary} />
      {popular.data && popular.data.length > 0 && (
        <section className="section">
          <h2>Popular</h2>
          <TrackList tracks={showAllPopular ? popular.data : popular.data.slice(0, 5)} showCover numbered="position" showArtist={false} />
          {popular.data.length > 5 && (
            <button className="link" onClick={() => setShowAllPopular(!showAllPopular)}>
              {showAllPopular ? "Show less" : "Show more"}
            </button>
          )}
        </section>
      )}
      {albums.loading && <Loading />}
      {albums.data &&
        groupAlbums(albums.data).map(([title, list]) => (
          <section className="section" key={title}>
            <h2>{title}</h2>
            <div className="grid">
              {list.map((al) => (
                <AlbumCard key={al.ratingKey} a={al} sub={[al.year, al.format].filter(Boolean).join(" · ") || " "} />
              ))}
            </div>
          </section>
        ))}
      {a.similar?.length ? (
        <section className="section">
          <h2>Similar artists</h2>
          <div className="chips">
            {a.similar.map((s) => (
              <button key={s} className="chip" onClick={() => openSimilar(s)}>
                {s}
              </button>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

// ---- album -------------------------------------------------------------------------------

export function AlbumView({ id }: { id: string }) {
  const album = useData(`album:${id}`, () => server().album(id));
  const tracks = useData(`albumTracks:${id}`, () => server().albumTracks(id));
  const more = useData(album.data?.artistKey ? `artistAlbums:${album.data.artistKey}` : null, () => server().artistAlbums(album.data!.artistKey!));
  const go = useNav((s) => s.go);
  useRatings();

  if (album.error) return <ErrorBox error={album.error} retry={album.reload} />;
  if (!album.data) return <Loading />;
  const a = album.data;
  const t = tracks.data ?? [];
  const total = t.reduce((s, x) => s + x.duration, 0);
  const loved = ratingOf(a) === 10;
  const codec = t[0]?.codec ? `${t[0].codec.toUpperCase()}${t[0].bitrate ? ` ${t[0].bitrate} kbps` : ""}` : "";

  return (
    <div className="view">
      <Hero thumb={a.thumb} kicker={a.format ?? "Album"} title={a.title}>
        <div className="hero-sub">
          <span className="link-text strong" onClick={() => a.artistKey && go({ kind: "artist", id: a.artistKey })}>
            {a.artist}
          </span>
          {[a.year, t.length ? `${t.length} tracks` : null, total ? fmtDuration(total) : null, codec].filter(Boolean).map((x) => (
            <span key={String(x)}> · {x}</span>
          ))}
        </div>
        {a.genres?.length ? (
          <div className="chips small">
            {a.genres.map((g) => (
              <span key={g} className="chip static">
                {g}
              </span>
            ))}
          </div>
        ) : null}
        <div className="hero-actions">
          <button className="btn primary" onClick={() => player.playTracks(t)} disabled={!t.length}>
            <Play size={16} fill="currentColor" /> Play
          </button>
          <button className="btn" onClick={() => player.playTracks(t, 0, { shuffle: true })} disabled={!t.length}>
            <Shuffle size={16} /> Shuffle
          </button>
          <button className="icon-btn big" title="Play next" onClick={() => player.playNext(t)}>
            <ListStart size={18} />
          </button>
          <button className="icon-btn big" title="Add to queue" onClick={() => player.addToQueue(t)}>
            <ListEnd size={18} />
          </button>
          <button className={`icon-btn big heart ${loved ? "on" : ""}`} title={loved ? "Unlove album" : "Love album"} onClick={() => setLoved(a, !loved)}>
            <Heart size={18} fill={loved ? "currentColor" : "none"} />
          </button>
          <button className="icon-btn big" title="More" onClick={(e) => openMenu(e, albumMenu(a))}>
            <MoreHorizontal size={18} />
          </button>
        </div>
      </Hero>
      {tracks.loading ? <Loading /> : <TrackList tracks={t} discs />}
      {a.studio && <p className="dim small pad">{a.studio}</p>}
      <Summary text={a.summary} />
      {more.data && more.data.filter((x) => x.ratingKey !== id).length > 0 && (
        <Shelf title={`More by ${a.artist}`} onMore={() => a.artistKey && go({ kind: "artist", id: a.artistKey })}>
          {more.data
            .filter((x) => x.ratingKey !== id)
            .sort((x, y) => (y.year ?? 0) - (x.year ?? 0))
            .map((x) => (
              <AlbumCard key={x.ratingKey} a={x} sub={x.year ? String(x.year) : " "} />
            ))}
        </Shelf>
      )}
    </div>
  );
}

// ---- playlist -------------------------------------------------------------------------------

async function lovedTracks(): Promise<Track[]> {
  const s = server();
  const p = await s.page(`/library/sections/${sectionKey()}/all`, { type: 10, userRating: 10, sort: "lastRatedAt:desc" }, 0, 5000);
  return p.items.map(toTrack);
}

export function PlaylistView({ id }: { id: string }) {
  const isLoved = id === "loved";
  const meta = useData(isLoved ? null : `playlistMeta:${id}`, () => server().playlist(id));
  const tracks = useData(`playlist:${id}`, () => (isLoved ? lovedTracks() : server().playlistTracks(id)));
  const [q, setQ] = useState("");
  const go = useNav((s) => s.go);
  const list = tracks.data ?? [];
  const filtered = useMemo(() => {
    const n = q.toLowerCase().trim();
    return n ? list.filter((t) => `${t.title} ${t.artist} ${t.album}`.toLowerCase().includes(n)) : list;
  }, [list, q]);

  if (tracks.error) return <ErrorBox error={tracks.error} retry={tracks.reload} />;
  const title = isLoved ? "Loved tracks" : meta.data?.title ?? "Playlist";
  const smart = isLoved || meta.data?.smart;
  const total = list.reduce((s, x) => s + x.duration, 0);

  const rename = async () => {
    const name = await prompt("Rename playlist", title);
    if (!name) return;
    await server().renamePlaylist(id, name);
    invalidate(`playlistMeta:${id}`);
    invalidate("playlists");
    meta.reload();
    usePlaylists.getState().refresh();
  };
  const remove = async () => {
    if (!(await confirmDialog(`Delete playlist “${title}”? This can't be undone.`))) return;
    await server().deletePlaylist(id);
    invalidate("playlists");
    usePlaylists.getState().refresh();
    toast(`Deleted “${title}”`);
    go({ kind: "playlists" });
  };

  return (
    <div className="view">
      <Hero thumb={meta.data?.thumb} kicker={smart ? "Smart playlist" : "Playlist"} title={title}>
        <div className="hero-sub dim">
          {list.length} tracks{total ? ` · ${fmtDuration(total)}` : ""}
        </div>
        <div className="hero-actions">
          <button className="btn primary" onClick={() => player.playTracks(list)} disabled={!list.length}>
            <Play size={16} fill="currentColor" /> Play
          </button>
          <button className="btn" onClick={() => player.playTracks(list, 0, { shuffle: true })} disabled={!list.length}>
            <Shuffle size={16} /> Shuffle
          </button>
          <button className="icon-btn big" title="Add to queue" onClick={() => player.addToQueue(list)}>
            <ListEnd size={18} />
          </button>
          {!smart && (
            <>
              <button className="icon-btn big" title="Rename" onClick={rename}>
                <Pencil size={17} />
              </button>
              <button className="icon-btn big" title="Delete playlist" onClick={remove}>
                <Trash2 size={17} />
              </button>
            </>
          )}
          <div className="grow" />
          <div className="filter">
            <Search size={15} />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter" onKeyDown={(e) => e.key === "Escape" && setQ("")} />
          </div>
        </div>
      </Hero>
      {tracks.loading ? (
        <Loading />
      ) : (
        <TrackList
          tracks={filtered}
          showAlbum
          showArtist
          showCover
          numbered="position"
          playlistId={smart ? undefined : id}
          onRemoved={tracks.reload}
        />
      )}
      {!tracks.loading && !list.length && <p className="dim pad">{isLoved ? "Tracks you love (♥) show up here." : "This playlist is empty. Right-click any track → Add to playlist."}</p>}
    </div>
  );
}
