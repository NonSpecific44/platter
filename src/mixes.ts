// "Made for you": playlists Platter puts together from your Plex listening history.
//   Daylist: what you tend to play at this time of day, plus music like it. A new one each part of
//   the day, named after its sound, e.g. "Trip Hop Tuesday evening".
//   Suggestions: music you haven't heard much, near what you play most. A new one each day.
import { Track } from "./plex";
import { similarTracks } from "./similar";
import { isExcluded, loadJson, sectionKey, server, useSession } from "./store";

export interface Mix {
  id: "daylist" | "suggestions";
  title: string;
  subtitle: string;
  tracks: Track[];
  /** Which period it belongs to; a new one is made when this changes. */
  period: string;
}

const PARTS: [number, string][] = [
  [5, "early morning"],
  [9, "morning"],
  [12, "afternoon"],
  [17, "evening"],
  [21, "night"],
];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** "late night" before 5 am, then the parts above. */
function partOf(hour: number) {
  let part = "late night";
  for (const [from, name] of PARTS) if (hour >= from) part = name;
  return part;
}

const today = () => new Date().toDateString();
export const periodOf = (id: Mix["id"]) => (id === "daylist" ? `${today()} ${partOf(new Date().getHours())}` : today());

async function myHistory() {
  const user = useSession.getState().user as { title?: string; username?: string } | undefined;
  return server().history(sectionKey(), 2000, [user?.title ?? "", user?.username ?? ""]);
}

/** Most common first. */
function ranked<T>(xs: T[]) {
  const n = new Map<T, number>();
  for (const x of xs) n.set(x, (n.get(x) ?? 0) + 1);
  return [...n.entries()].sort((a, b) => b[1] - a[1]).map(([x]) => x);
}

const shuffle = <T,>(xs: T[]) => [...xs].sort(() => Math.random() - 0.5);

/** The style (or genre) most of these tracks' albums share, for naming a mix. */
async function soundOf(tracks: Track[]) {
  const s = server();
  const keys = ranked(tracks.map((t) => t.albumKey).filter((k): k is string => !!k && !k.startsWith("local"))).slice(0, 8);
  const albums = await Promise.all(keys.map((k) => s.album(k).catch(() => null)));
  const styles = ranked(albums.flatMap((a) => a?.styles ?? []));
  return styles[0] ?? ranked(albums.flatMap((a) => a?.genres ?? []))[0] ?? "";
}

const titleCase = (s: string) => s.replace(/\b\w/g, (c) => c.toUpperCase());

async function makeDaylist(): Promise<Mix> {
  const now = new Date();
  const part = partOf(now.getHours());
  const history = await myHistory();
  // Plays at this time of day on any day, favouring the same day of the week a little.
  const atThisTime = history.filter((h) => partOf(new Date(h.viewedAt * 1000).getHours()) === part);
  const weighted = [...atThisTime, ...atThisTime.filter((h) => new Date(h.viewedAt * 1000).getDay() === now.getDay())];
  const pool = weighted.length >= 10 ? weighted : history;
  const favourites = await server().tracks(ranked(pool.map((h) => h.ratingKey)).slice(0, 30));
  const picked = shuffle(favourites.filter((t) => !isExcluded(t))).slice(0, 15);
  const fresh = picked.length ? await similarTracks(picked, new Set(picked.map((t) => t.ratingKey)), 25) : [];
  const tracks = shuffle([...picked, ...fresh]);
  const sound = await soundOf(picked);
  return {
    id: "daylist",
    title: `${sound ? `${titleCase(sound)} ` : ""}${DAYS[now.getDay()]} ${part}`,
    subtitle: "daylist · changes through the day",
    tracks,
    period: periodOf("daylist"),
  };
}

async function makeSuggestions(): Promise<Mix> {
  const history = await myHistory();
  const heard = new Set(history.map((h) => h.ratingKey));
  // Seeds: a spread of tracks by the artists you play most.
  const topArtists = new Set(ranked(history.map((h) => h.artist)).slice(0, 10));
  const seedKeys = shuffle(ranked(history.filter((h) => topArtists.has(h.artist)).map((h) => h.ratingKey)).slice(0, 40)).slice(0, 12);
  const seeds = await server().tracks(seedKeys);
  const others: Track[] = [];
  const familiar: Track[] = [];
  // In rounds of a few seeds, so the mix covers more than one corner of your taste. Artists you
  // already play a lot only fill in, with tracks you haven't heard.
  for (let i = 0; i < seeds.length && others.length < 30; i += 3) {
    const exclude = new Set([...heard, ...others.map((t) => t.ratingKey), ...familiar.map((t) => t.ratingKey)]);
    for (const t of await similarTracks(seeds.slice(i, i + 3), exclude, 12)) (topArtists.has(t.artist) ? familiar : others).push(t);
  }
  const tracks = [...others, ...familiar].slice(0, 30);
  return {
    id: "suggestions",
    title: "Suggestions",
    subtitle: "New to you, based on what you play most",
    tracks: shuffle(tracks).slice(0, 30),
    period: periodOf("suggestions"),
  };
}

const KEY = (id: Mix["id"]) => `tonearm.mix.${id}.${sectionKey()}`;
const making = new Map<string, Promise<Mix>>();

/** This period's mix: kept until the period changes, so it doesn't reshuffle on every visit. */
export function getMix(id: Mix["id"], fresh = false): Promise<Mix> {
  const saved = loadJson<Mix | null>(KEY(id), null);
  if (!fresh && saved && saved.period === periodOf(id) && saved.tracks.length) return Promise.resolve(saved);
  let p = making.get(id);
  if (!p) {
    p = (id === "daylist" ? makeDaylist() : makeSuggestions())
      .then((mix) => {
        try {
          localStorage.setItem(KEY(id), JSON.stringify(mix));
        } catch {
          /* still shown, just made again next time */
        }
        return mix;
      })
      .finally(() => making.delete(id));
    making.set(id, p);
  }
  return p;
}

/** The last one made, for showing a card straight away. */
export const savedMix = (id: Mix["id"]) => loadJson<Mix | null>(KEY(id), null);
