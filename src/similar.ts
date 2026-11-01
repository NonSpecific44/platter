// "More like this" for Autoplay: what to play once the queue runs out.
import { Track } from "./plex";
import { sectionKey, server } from "./store";

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

/**
 * Tracks similar to `seeds`, best sources first: Plex's sonic analysis (nearest neighbours),
 * then tracks by the seeds' artists and their similar artists, then the rest of the library.
 */
export async function similarTracks(seeds: Track[], exclude: Set<string>, count: number): Promise<Track[]> {
  const s = server();
  const sec = sectionKey();
  const found = new Map<string, Track>();
  const add = (tracks: Track[]) => {
    for (const t of tracks) if (!exclude.has(t.ratingKey) && !found.has(t.ratingKey)) found.set(t.ratingKey, t);
  };

  await Promise.all(seeds.slice(-3).map((t) => s.nearest(t.ratingKey, 30).then(add, () => undefined)));

  if (found.size < count) {
    const artistKeys = [...new Set(seeds.map((t) => t.artistKey).filter((k): k is string => !!k))].slice(-2);
    await Promise.all(
      artistKeys.map(async (key) => {
        add(await s.randomTracks(sec, 4, { "artist.id": key }).catch(() => []));
        const artist = await s.artist(key).catch(() => null);
        for (const name of artist?.similar?.slice(0, 5) ?? []) {
          const hubs = await s.search(sec, name).catch(() => []);
          const hit = hubs.find((h) => h.type === "artist")?.items.find((x) => x.title.toLowerCase() === name.toLowerCase());
          if (hit) add(await s.randomTracks(sec, 5, { "artist.id": hit.ratingKey }).catch(() => []));
        }
      }),
    );
  }

  if (found.size < count) add(await s.randomTracks(sec, count * 2).catch(() => []));
  return spread([...found.values()]).slice(0, count);
}
