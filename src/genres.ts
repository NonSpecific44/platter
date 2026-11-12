// What each artist sounds like, as weighted genre tags: MusicBrainz's community tags (specific,
// like "future bass" or "conscious hip hop"), topped up with Plex's broader genres. Autoplay and the
// mixes use these to stay within a sound, since Plex's own similarity needs sonic analysis.
// MusicBrainz asks for at most one request a second, so tags are fetched slowly in the background
// and kept; anything needed right now goes to the front of the line.
import { fetch } from "@tauri-apps/plugin-http";
import { loadJson, sectionKey, server } from "./store";

export type Tags = Record<string, number>;

const UA = "Platter/0.3 ( https://github.com/NonSpecific44/platter )";
const STORE = "tonearm.artistTags";
const MAX_AGE = 90 * 24 * 3600_000;

/** Not about the sound. */
const NOISE = /^(seen live|favorite|favourites?|my|male vocalists?|female vocalists?|\d0s|\d{4}s?|australia|australian|british|english|uk|usa|american|canadian|french|german|swedish|japanese|korean|new zealand)$/;
/** Broad families: "conscious hip hop" also counts a little towards "hip hop". */
const FAMILIES = ["hip hop", "rap", "rock", "pop", "house", "techno", "jazz", "soul", "funk", "folk", "metal", "punk", "r&b", "electronic", "ambient", "dubstep", "bass", "trap", "indie", "dance", "disco", "blues", "country", "classical", "reggae", "edm", "psychedelic"];

const norm = (s: string) => s.toLowerCase().replace(/[‐-―]/g, "-").replace(/\s+/g, " ").trim();
/** The main artist of a credit: "Flume feat. Tove Lo" is Flume. */
const primary = (artist: string) => artist.split(/\s+(?:feat\.?|ft\.?|featuring|with)\s+/i)[0].trim() || artist;
const keyOf = (artist: string) => norm(primary(artist));

let store: Record<string, { tags: Tags; at: number }> = loadJson(STORE, {});

function save() {
  try {
    localStorage.setItem(STORE, JSON.stringify(store));
  } catch {
    /* full or private: tags are fetched again next time */
  }
}

function weigh(raw: { name: string; count: number }[]): Tags {
  const tags: Tags = {};
  const top = Math.max(1, ...raw.map((t) => t.count));
  for (const { name, count } of raw) {
    const t = norm(name);
    if (!t || NOISE.test(t) || count <= 0) continue;
    const w = count / top;
    tags[t] = Math.max(tags[t] ?? 0, w);
    for (const f of FAMILIES) if (t !== f && t.includes(f)) tags[f] = Math.max(tags[f] ?? 0, w / 2);
  }
  return tags;
}

// ---- MusicBrainz, one request a second ----

let chain = Promise.resolve();
let last = 0;

function throttled<T>(job: () => Promise<T>): Promise<T> {
  const run = chain.then(async () => {
    const wait = last + 1100 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    last = Date.now();
    return job();
  });
  chain = run.then(() => undefined, () => undefined);
  return run;
}

async function lookup(artist: string): Promise<Tags> {
  const q = `artist:"${artist.replace(/(["\\])/g, "\\$1")}"`;
  const r = await fetch(`https://musicbrainz.org/ws/2/artist?fmt=json&limit=3&query=${encodeURIComponent(q)}`, {
    headers: { "User-Agent": UA, Accept: "application/json" },
  });
  if (!r.ok) throw new Error(`MusicBrainz returned ${r.status}`);
  const hits: any[] = (await r.json()).artists ?? [];
  // A close name match only; a wrong artist's tags would be worse than none.
  const hit = hits.find((a) => a.score >= 90 && norm(a.name) === keyOf(artist)) ?? hits.find((a) => a.score >= 98);
  return weigh(hit?.tags ?? []);
}

const pending = new Map<string, Promise<Tags>>();

/** An artist's tags, fetching them if they aren't known yet. */
export function tagsOf(artist: string): Promise<Tags> {
  const k = keyOf(artist);
  const known = store[k];
  if (known && Date.now() - known.at < MAX_AGE) return Promise.resolve(known.tags);
  let p = pending.get(k);
  if (!p) {
    p = throttled(() => lookup(primary(artist)))
      .then((tags) => {
        store[k] = { tags: { ...(store[k]?.tags ?? {}), ...tags }, at: Date.now() };
        save();
        return store[k].tags;
      })
      .catch(() => known?.tags ?? {})
      .finally(() => pending.delete(k));
    pending.set(k, p);
  }
  return p;
}

/** Tags already known, without asking anyone. */
export const knownTags = (artist: string): Tags => store[keyOf(artist)]?.tags ?? {};

// ---- the library's artists ----

let artists: Promise<{ name: string; key: string; genres: string[] }[]> | null = null;
let artistsFor = "";

/** Every artist in the library, with Plex's genres for those MusicBrainz doesn't know. */
export function libraryArtists() {
  const sec = sectionKey();
  if (!artists || artistsFor !== sec) {
    artistsFor = sec;
    artists = server()
      .artists(sec, "titleSort", 0, 20000)
      .then((p) => p.items.map((a) => ({ name: a.title, key: a.ratingKey, genres: a.genres ?? [] })))
      .catch(() => {
        artists = null;
        return [];
      });
  }
  return artists;
}

function vectorOf(a: { name: string; genres: string[] }): Tags {
  const v: Tags = { ...knownTags(a.name) };
  // Plex's broad genres count for less than MusicBrainz's specific ones.
  for (const g of a.genres) for (const part of norm(g).split(/[/&,]/).map((x) => x.trim()).filter(Boolean)) v[part] = Math.max(v[part] ?? 0, 0.4);
  return v;
}

export function similarity(a: Tags, b: Tags) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const [t, w] of Object.entries(a)) {
    na += w * w;
    if (b[t]) dot += w * b[t];
  }
  for (const w of Object.values(b)) nb += w * w;
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** Tags added up across artists, weighted by how much each counts. */
export function blend(parts: { tags: Tags; weight: number }[]): Tags {
  const out: Tags = {};
  for (const { tags, weight } of parts) for (const [t, w] of Object.entries(tags)) out[t] = (out[t] ?? 0) + w * weight;
  const top = Math.max(0, ...Object.values(out));
  if (top) for (const t of Object.keys(out)) out[t] /= top;
  return out;
}

/** Library artists closest in sound to `target`, best first. */
export async function nearestArtists(target: Tags, count: number, skip: Set<string> = new Set()) {
  const all = await libraryArtists();
  return all
    .filter((a) => !skip.has(keyOf(a.name)))
    .map((a) => ({ ...a, score: similarity(target, vectorOf(a)) }))
    // Close matches only: sharing just "pop" or "electronic" isn't the same sound.
    .filter((a) => a.score > 0.4)
    .sort((x, y) => y.score - x.score)
    .slice(0, count);
}

/** The tags of a set of artists (by name), fetching what's missing first. */
export async function blendOf(names: string[], weights?: number[]): Promise<Tags> {
  const all = await libraryArtists();
  const byName = new Map(all.map((a) => [keyOf(a.name), a]));
  const parts = await Promise.all(
    names.map(async (n, i) => {
      await tagsOf(n);
      const a = byName.get(keyOf(n)) ?? { name: n, genres: [] };
      return { tags: vectorOf(a), weight: weights?.[i] ?? 1 };
    }),
  );
  return blend(parts);
}

/** The single tag that best describes `tags`, preferring specific ones over broad families. */
export function themeOf(tags: Tags) {
  const ranked = Object.entries(tags).sort((a, b) => b[1] - a[1]);
  const specific = ranked.find(([t, w]) => !FAMILIES.includes(t) && w >= 0.5);
  return (specific ?? ranked[0])?.[0] ?? "";
}

export const sameArtist = (a: string, b: string) => keyOf(a) === keyOf(b);

/** Who leads a credit, for keeping one artist from taking over: "The Black Eyed Peas",
 *  "Black Eyed Peas" and "Hermitude & IsGwan" count as Black Eyed Peas and Hermitude. */
export const leadArtist = (artist: string) =>
  norm(artist.split(/\s+(?:feat\.?|ft\.?|featuring|pheaturing|with|&|x|and|vs\.?)\s+|,\s*/i)[0] || artist).replace(/^the /, "");

/** At most `n` tracks led by any one artist, keeping the order. */
export function capPerArtist<T extends { artist: string }>(tracks: T[], n: number) {
  const seen = new Map<string, number>();
  return tracks.filter((t) => {
    const k = leadArtist(t.artist);
    const c = (seen.get(k) ?? 0) + 1;
    seen.set(k, c);
    return c <= n;
  });
}
export const artistKey = keyOf;

let indexing = false;

/** Fills in tags for the whole library, slowly, so autoplay and mixes know every artist. */
export async function startTagIndex() {
  if (indexing) return;
  indexing = true;
  try {
    const all = await libraryArtists();
    for (const a of all) {
      const known = store[keyOf(a.name)];
      if (known && Date.now() - known.at < MAX_AGE) continue;
      await tagsOf(a.name);
    }
  } finally {
    indexing = false;
  }
}
