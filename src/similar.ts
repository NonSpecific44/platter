// "More like this" for Autoplay: what to play once the queue runs out.
import { Album, Track } from "./plex";
import { isExcluded, sectionKey, server } from "./store";
import { blendOf, leadArtist, nearestArtists } from "./genres";

/** Reorders so the same artist rarely plays twice in a row. */
function spread(tracks: Track[]) {
  const pool = [...tracks].sort(() => Math.random() - 0.5);
  const out: Track[] = [];
  while (pool.length) {
    const last = out[out.length - 1]?.artist;
    const i = pool.findIndex((t) => t.artist !== last);
    out.push(pool.splice(i < 0 ? 0 : i, 1)[0]);
  }
  return out;
}

const pick = <T,>(xs: T[], n: number) => [...xs].sort(() => Math.random() - 0.5).slice(0, n);

const tagKeys = new Map<string, Promise<Map<string, string>>>();

/** Name → filter key for the library's album genres or styles, fetched once per library. */
function keysFor(kind: "genre" | "style") {
  const id = `${sectionKey()}:${kind}`;
  let p = tagKeys.get(id);
  if (!p) {
    p = server()
      .tagList(sectionKey(), kind)
      .then((list) => new Map(list.map((t) => [t.title.toLowerCase(), t.key])))
      .catch(() => {
        tagKeys.delete(id);
        return new Map<string, string>();
      });
    tagKeys.set(id, p);
  }
  return p;
}

/** A few random tracks from random albums sharing one of `tags` (most common first). */
async function fromAlbumsTagged(kind: "genre" | "style", tags: string[], want: number): Promise<Track[]> {
  if (!tags.length) return [];
  const s = server();
  const keys = await keysFor(kind);
  const out: Track[] = [];
  for (const tag of tags) {
    const key = keys.get(tag.toLowerCase());
    if (!key) continue;
    const albums = await s
      .albums(sectionKey(), { sort: "random", [kind]: key }, 0, 6)
      .then((p) => p.items)
      .catch(() => [] as Album[]);
    for (const a of albums) {
      const tracks = await s.albumTracks(a.ratingKey).catch(() => []);
      out.push(...pick(tracks, 2));
    }
    if (out.length >= want) break;
  }
  return out;
}

/** The seeds' album genres and styles, most common first. */
async function seedTags(seeds: Track[]) {
  const s = server();
  const albumKeys = [...new Set(seeds.map((t) => t.albumKey).filter((k): k is string => !!k && !k.startsWith("local")))].slice(-4);
  const albums = await Promise.all(albumKeys.map((k) => s.album(k).catch(() => null)));
  const rank = (lists: (string[] | undefined)[]) => {
    const n = new Map<string, number>();
    for (const l of lists) for (const t of l ?? []) n.set(t, (n.get(t) ?? 0) + 1);
    return [...n.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t);
  };
  return { styles: rank(albums.map((a) => a?.styles)), genres: rank(albums.map((a) => a?.genres)) };
}

/**
 * Tracks similar to `seeds`, best sources first: Plex's sonic analysis (nearest neighbours), then
 * artists that sound like the seeds' (genre tags, see genres.ts), then Plex's similar artists, then
 * albums sharing the seeds' styles and genres. Random tracks from the whole library are only a
 * last resort.
 */
export async function similarTracks(seeds: Track[], exclude: Set<string>, count: number): Promise<Track[]> {
  const s = server();
  const sec = sectionKey();
  const found = new Map<string, Track>();
  const perArtist = new Map<string, number>();
  // No one artist takes over the queue, however much the sources agree on them.
  const add = (tracks: Track[], cap = 4) => {
    for (const t of tracks) {
      if (found.size >= count * 2 || exclude.has(t.ratingKey) || isExcluded(t) || found.has(t.ratingKey)) continue;
      const lead = leadArtist(t.artist);
      const n = perArtist.get(lead) ?? 0;
      if (n >= cap) continue;
      perArtist.set(lead, n + 1);
      found.set(t.ratingKey, t);
    }
  };

  const [tags] = await Promise.all([
    seedTags(seeds).catch(() => ({ styles: [] as string[], genres: [] as string[] })),
    ...seeds.slice(-3).map((t) => s.nearest(t.ratingKey, 30).then(add, () => undefined)),
  ]);

  if (found.size < count) {
    // Artists in the same sound, closest first, the seeds' own included.
    const names = [...new Set(seeds.map((t) => t.artist))].slice(-3);
    const target = await blendOf(names).catch((): Record<string, number> => ({}));
    if (Object.keys(target).length) {
      const near = await nearestArtists(target, 10).catch(() => []);
      const tracks = await Promise.all(near.map((a) => s.randomTracks(sec, 3, { "artist.id": a.key }).catch(() => [])));
      for (const t of tracks) add(t, 3);
    }
  }

  if (found.size < count) {
    const artistKeys = [...new Set(seeds.map((t) => t.artistKey).filter((k): k is string => !!k))].slice(-2);
    await Promise.all(
      artistKeys.map(async (key) => {
        add(await s.randomTracks(sec, 3, { "artist.id": key }).catch(() => []), 3);
        const artist = await s.artist(key).catch(() => null);
        for (const name of artist?.similar?.slice(0, 6) ?? []) {
          const hubs = await s.search(sec, name).catch(() => []);
          const hit = hubs.find((h) => h.type === "artist")?.items.find((x) => x.title.toLowerCase() === name.toLowerCase());
          if (hit) add(await s.randomTracks(sec, 3, { "artist.id": hit.ratingKey }).catch(() => []), 3);
        }
      }),
    );
  }

  if (found.size < count) add(await fromAlbumsTagged("style", tags.styles.slice(0, 3), count - found.size), 2);
  if (found.size < count) add(await fromAlbumsTagged("genre", tags.genres.slice(0, 3), count - found.size), 2);
  if (!found.size) add(await s.randomTracks(sec, count * 2).catch(() => []));
  return spread([...found.values()]).slice(0, count);
}
