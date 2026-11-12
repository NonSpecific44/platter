// "Made for you": playlists Platter puts together from your Plex listening history.
//   Daylist: what you tend to play at this time of day, plus music like it. A new one each part of
//   the day, named after its sound, e.g. "Trip Hop Tuesday evening".
//   Suggestions: music you haven't heard much, near what you play most. A new one each day.
import { Track } from "./plex";
import { similarTracks } from "./similar";
import { Tags, artistKey, blend, blendOf, capPerArtist, leadArtist, nearestArtists, themeOf } from "./genres";
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
  // The sound you play most at this time: one theme, not a bit of everything.
  const plays = new Map<string, number>();
  for (const h of pool) plays.set(artistKey(h.artist), (plays.get(artistKey(h.artist)) ?? 0) + 1);
  const top = ranked(pool.map((h) => h.artist)).slice(0, 12);
  const each: Tags[] = await Promise.all(top.map((a) => blendOf([a]).catch((): Tags => ({}))));
  const theme = themeOf(blend(each.map((tags, i) => ({ tags, weight: plays.get(artistKey(top[i])) ?? 1 }))));
  const inTheme = new Set(top.filter((_, i) => theme && (each[i][theme] ?? 0) >= 0.3).map(artistKey));
  const themed = inTheme.size ? pool.filter((h) => inTheme.has(artistKey(h.artist))) : pool;
  const favourites = await server().tracks(ranked(themed.map((h) => h.ratingKey)).slice(0, 30));
  const picked = capPerArtist(shuffle(favourites.filter((t) => !isExcluded(t))), 3).slice(0, 15);
  const fresh = picked.length ? await similarTracks(picked, new Set(picked.map((t) => t.ratingKey)), 30) : [];
  const tracks = shuffle(capPerArtist([...picked, ...fresh], 4)).slice(0, 40);
  const sound = theme || (await soundOf(picked));
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
  // Artists that sound like your favourites but that you've hardly played.
  const counts = new Map<string, number>();
  for (const h of history) counts.set(artistKey(h.artist), (counts.get(artistKey(h.artist)) ?? 0) + 1);
  const favourites = ranked(history.map((h) => h.artist)).slice(0, 10);
  const target = await blendOf(favourites, favourites.map((a) => counts.get(artistKey(a)) ?? 1)).catch((): Tags => ({}));
  const familiarArtists = new Set([...counts.entries()].filter(([, n]) => n >= 3).map(([a]) => a));
  const familiarLeads = new Set([...familiarArtists].map(leadArtist));
  const near = Object.keys(target).length ? await nearestArtists(target, 25, familiarArtists).catch(() => []) : [];
  const discovered: Track[] = [];
  const leads = new Map<string, number>();
  for (const a of near) {
    // "Hermitude & IsGwan" is still Hermitude: not new to you, and not twelve times over.
    const lead = leadArtist(a.name);
    if (familiarLeads.has(lead) || (leads.get(lead) ?? 0) >= 2) continue;
    leads.set(lead, (leads.get(lead) ?? 0) + 2);
    const t = await server().randomTracks(sectionKey(), 4, { "artist.id": a.key }).catch(() => [] as Track[]);
    discovered.push(...t.filter((x) => !heard.has(x.ratingKey) && !isExcluded(x)).slice(0, 2));
    if (discovered.length >= 30) break;
  }
  if (discovered.length >= 15) {
    return { id: "suggestions", title: "Suggestions", subtitle: "New to you, based on what you play most", tracks: shuffle(discovered).slice(0, 30), period: periodOf("suggestions") };
  }
  // Not enough tag data yet: fall back to similar tracks around your favourites.
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
