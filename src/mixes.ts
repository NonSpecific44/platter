// "Made for you": playlists Platter puts together from your Plex listening history.
//   Daylist: what you tend to play at this time of day, plus music like it. A new one each part of
//   the day, named after its sound, e.g. "Trip Hop Tuesday evening".
//   Suggestions: music you haven't heard much, near what you play most. A new one each day.
//   Daily Mix 1-3: each one style you play a lot, your favourites in it plus more like them. Daily.
//   On Repeat: what you've played most over the last month. Daily.
//   Repeat Rewind: songs you used to play a lot and haven't lately. Daily.
//   New for you: music added to the library recently, by artists you play or that sound like
//   them. Weekly, from Friday, like Release Radar.
import { Track, toTrack } from "./plex";
import { similarTracks } from "./similar";
import { Tags, artistKey, blend, blendOf, capPerArtist, leadArtist, nearestArtists, themeOf } from "./genres";
import { isExcluded, loadJson, sectionKey, server, useSession } from "./store";
import { invoke } from "@tauri-apps/api/core";
import { isAndroid } from "./platform";
import { mixArt, savedArt } from "./mixArt";

export const MIX_IDS = ["daylist", "suggestions", "daily1", "daily2", "daily3", "onrepeat", "rewind", "newforyou"] as const;
export type MixId = (typeof MIX_IDS)[number];
export const isMixId = (id: string): id is MixId => (MIX_IDS as readonly string[]).includes(id);

/** What each mix is called before it's made (and on its cover). */
export const MIX_LABEL: Record<MixId, string> = {
  daylist: "daylist",
  suggestions: "Suggestions",
  daily1: "Daily Mix 1",
  daily2: "Daily Mix 2",
  daily3: "Daily Mix 3",
  onrepeat: "On Repeat",
  rewind: "Repeat Rewind",
  newforyou: "New for you",
};

export interface Mix {
  id: MixId;
  title: string;
  subtitle: string;
  tracks: Track[];
  /** Which period it belongs to; a new one is made when this changes. */
  period: string;
  /** The style a Daily Mix is built around. */
  theme?: string;
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
/** The Friday this week's "New for you" started on. */
function lastFriday() {
  const d = new Date();
  d.setDate(d.getDate() - ((d.getDay() + 2) % 7));
  return `week of ${d.toDateString()}`;
}
export const periodOf = (id: MixId) =>
  id === "daylist" ? `${today()} ${partOf(new Date().getHours())}` : id === "newforyou" ? lastFriday() : today();

type Play = { ratingKey: string; artist: string; viewedAt: number };
const histories = new Map<number, { at: number; p: Promise<Play[]> }>();

/** Your plays, newest first; shared by all the mixes made in the same few minutes. */
function myHistory(size = 2000): Promise<Play[]> {
  const cached = histories.get(size);
  if (cached && Date.now() - cached.at < 10 * 60_000) return cached.p;
  const user = useSession.getState().user as { title?: string; username?: string } | undefined;
  const p = server().history(sectionKey(), size, [user?.title ?? "", user?.username ?? ""]);
  histories.set(size, { at: Date.now(), p });
  p.catch(() => histories.delete(size));
  return p;
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

// ---- Daily Mixes ------------------------------------------------------------------------

interface Cluster {
  theme: string;
  artists: string[];
}

let clusters: { day: string; p: Promise<Cluster[]> } | null = null;

/** Up to three styles you play a lot, each with its artists, most played first. */
function dailyClusters(): Promise<Cluster[]> {
  if (clusters?.day === today()) return clusters.p;
  const p = (async () => {
    const history = await myHistory();
    const plays = new Map<string, number>();
    for (const h of history) plays.set(artistKey(h.artist), (plays.get(artistKey(h.artist)) ?? 0) + 1);
    const top = ranked(history.map((h) => h.artist)).slice(0, 40);
    const tags: Tags[] = await Promise.all(top.map((a) => blendOf([a]).catch((): Tags => ({}))));
    const out: Cluster[] = [];
    const used = new Set<string>();
    for (let i = 0; i < top.length && out.length < 3; i++) {
      if (used.has(artistKey(top[i]))) continue;
      const theme = themeOf(tags[i]);
      if (!theme || out.some((c) => c.theme === theme)) continue;
      const members = top.filter((a, j) => !used.has(artistKey(a)) && (tags[j][theme] ?? 0) >= 0.3);
      // A style needs a few artists to make a mix of its own.
      if (members.length < 3) continue;
      members.forEach((a) => used.add(artistKey(a)));
      out.push({ theme, artists: members });
    }
    return out;
  })();
  clusters = { day: today(), p };
  p.catch(() => (clusters = null));
  return p;
}

/** "Hermitude, Flume and Golden Features" for a mix's subtitle. */
function artistLine(names: string[]) {
  // Main artists only: "Gorillaz feat. MF DOOM" is Gorillaz, and Gorillaz only once.
  const main = names.map((a) => a.split(/\s+(?:feat\.?|ft\.?|featuring|with|&|x|and|vs\.?)\s+|,\s*/i)[0].trim()).filter(Boolean);
  const n = [...new Map(main.map((a) => [artistKey(a), a])).values()].slice(0, 3);
  return n.length < 2 ? n.join("") : `${n.slice(0, -1).join(", ")} and ${n[n.length - 1]}`;
}

async function makeDaily(n: 1 | 2 | 3): Promise<Mix> {
  const cluster = (await dailyClusters())[n - 1];
  if (!cluster) throw new Error("Not enough listening yet for this one");
  const history = await myHistory();
  const members = new Set(cluster.artists.map(artistKey));
  const theirs = history.filter((h) => members.has(artistKey(h.artist)));
  const favourites = await server().tracks(ranked(theirs.map((h) => h.ratingKey)).slice(0, 40));
  const picked = capPerArtist(shuffle(favourites.filter((t) => !isExcluded(t))), 3).slice(0, 18);
  const fresh = picked.length ? await similarTracks(picked, new Set(picked.map((t) => t.ratingKey)), 30) : [];
  const tracks = shuffle(capPerArtist([...picked, ...fresh], 4)).slice(0, 45);
  if (tracks.length < 10) throw new Error("Not enough listening yet for this one");
  return {
    id: `daily${n}`,
    title: MIX_LABEL[`daily${n}`],
    subtitle: artistLine(picked.map((t) => t.artist)),
    tracks,
    period: periodOf(`daily${n}`),
    theme: cluster.theme,
  };
}

// ---- On Repeat and Repeat Rewind ----------------------------------------------------------

const DAY_S = 86_400;

async function makeOnRepeat(): Promise<Mix> {
  const history = await myHistory();
  const now = Date.now() / 1000;
  const recent = (days: number) => history.filter((h) => now - h.viewedAt < days * DAY_S);
  // The last month, or longer if that's too little to go on.
  let pool = recent(30);
  if (new Set(pool.map((h) => h.ratingKey)).size < 20) pool = recent(90);
  const counts = new Map<string, number>();
  for (const h of pool) counts.set(h.ratingKey, (counts.get(h.ratingKey) ?? 0) + 1);
  const keys = [...counts.entries()].filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1]).map(([k]) => k).slice(0, 30);
  const byKey = new Map((await server().tracks(keys)).map((t) => [t.ratingKey, t]));
  const tracks = keys.map((k) => byKey.get(k)).filter((t): t is Track => !!t && !isExcluded(t));
  if (tracks.length < 8) throw new Error("Not enough listening yet for this one");
  return { id: "onrepeat", title: "On Repeat", subtitle: "Songs you can't stop playing", tracks, period: periodOf("onrepeat") };
}

async function makeRewind(): Promise<Mix> {
  const history = await myHistory(8000);
  const now = Date.now() / 1000;
  const lately = new Set(history.filter((h) => now - h.viewedAt < 60 * DAY_S).map((h) => h.ratingKey));
  const counts = new Map<string, number>();
  for (const h of history) if (!lately.has(h.ratingKey)) counts.set(h.ratingKey, (counts.get(h.ratingKey) ?? 0) + 1);
  const loved = [...counts.entries()].filter(([, c]) => c >= 3).sort((a, b) => b[1] - a[1]).map(([k]) => k);
  // The most-played first, mixed up a little each day.
  const keys = shuffle(loved.slice(0, 60)).slice(0, 30);
  const tracks = capPerArtist((await server().tracks(keys)).filter((t) => !isExcluded(t)), 4);
  if (tracks.length < 8) throw new Error("Not enough listening yet for this one");
  return { id: "rewind", title: "Repeat Rewind", subtitle: "Songs you used to play a lot", tracks: shuffle(tracks), period: periodOf("rewind") };
}

// ---- New for you ----------------------------------------------------------------------------

async function makeNewForYou(): Promise<Mix> {
  const history = await myHistory();
  const s = server();
  const page = await s.page(`/library/sections/${sectionKey()}/all`, { type: 10, sort: "addedAt:desc" }, 0, 1500);
  const since = Date.now() / 1000 - 60 * DAY_S;
  const addedAt = new Map<string, number>();
  const added = (page.items as any[])
    .filter((m) => (m.addedAt ?? 0) >= since)
    .map((m) => {
      const t = toTrack(m);
      addedAt.set(t.ratingKey, m.addedAt);
      return t;
    })
    .filter((t) => !isExcluded(t));
  if (!added.length) throw new Error("Nothing new in the library lately");
  const plays = new Map<string, number>();
  for (const h of history) plays.set(artistKey(h.artist), (plays.get(artistKey(h.artist)) ?? 0) + 1);
  const favourites = ranked(history.map((h) => h.artist)).slice(0, 15);
  const taste = await blendOf(favourites, favourites.map((a) => plays.get(artistKey(a)) ?? 1)).catch((): Tags => ({}));
  const near = new Set((Object.keys(taste).length ? await nearestArtists(taste, 200).catch(() => []) : []).map((a) => artistKey(a.name)));
  // Artists you play first, then ones that sound like them; a couple of tracks from each album.
  const score = (t: Track) => (plays.has(artistKey(t.artist)) ? 2 : near.has(artistKey(t.artist)) ? 1 : 0);
  const perAlbum = new Map<string, number>();
  const picked = added
    .filter((t) => score(t) > 0)
    .sort((a, b) => score(b) - score(a) || (addedAt.get(b.ratingKey) ?? 0) - (addedAt.get(a.ratingKey) ?? 0))
    .filter((t) => {
      const k = t.albumKey ?? t.ratingKey;
      const n = (perAlbum.get(k) ?? 0) + 1;
      perAlbum.set(k, n);
      return n <= 2;
    })
    .slice(0, 30);
  if (picked.length < 6) throw new Error("Nothing new in the library lately");
  return { id: "newforyou", title: "New for you", subtitle: "Recently added music from artists you like", tracks: picked, period: periodOf("newforyou") };
}

const MAKERS: Record<MixId, () => Promise<Mix>> = {
  daylist: makeDaylist,
  suggestions: makeSuggestions,
  daily1: () => makeDaily(1),
  daily2: () => makeDaily(2),
  daily3: () => makeDaily(3),
  onrepeat: makeOnRepeat,
  rewind: makeRewind,
  newforyou: makeNewForYou,
};

const KEY = (id: MixId) => `tonearm.mix.${id}.${sectionKey()}`;
const making = new Map<string, Promise<Mix>>();
/** Mixes are made one at a time, so opening Home doesn't fire off everything at once. */
let line: Promise<unknown> = Promise.resolve();

/** This period's mix: kept until the period changes, so it doesn't reshuffle on every visit. */
export function getMix(id: MixId, fresh = false): Promise<Mix> {
  const saved = loadJson<Mix | null>(KEY(id), null);
  if (!fresh && saved && saved.period === periodOf(id) && saved.tracks.length) return Promise.resolve(saved);
  let p = making.get(id);
  if (!p) {
    const made = line.then(() => MAKERS[id]());
    line = made.catch(() => undefined);
    p = made
      .then((mix) => {
        try {
          localStorage.setItem(KEY(id), JSON.stringify(mix));
        } catch {
          /* still shown, just made again next time */
        }
        // Its cover, then Android Auto gets both.
        void mixArt(mix).catch(() => undefined).finally(shareWithAuto);
        return mix;
      })
      .finally(() => making.delete(id));
    making.set(id, p);
  }
  return p;
}

/** Hands the latest mixes to Android Auto, which can't make them itself (it runs without the app). */
export function shareWithAuto() {
  if (!isAndroid()) return;
  const list = MIX_IDS.map((id) => savedMix(id))
    .filter((m): m is Mix => !!m?.tracks.length)
    .map((m) => ({
      id: m.id,
      label: MIX_LABEL[m.id],
      title: m.title === MIX_LABEL[m.id] ? m.subtitle : m.title,
      thumb: m.tracks[0]?.thumb ?? "",
      // The drawn cover as JPEG bytes (base64); Auto shows it without needing an address for it.
      art: savedArt(m.id)?.split("base64,")[1] ?? "",
      keys: m.tracks.filter((t) => !t.ratingKey.startsWith("local")).map((t) => t.ratingKey),
    }));
  void invoke("auto_mixes", { json: JSON.stringify(list) }).catch(() => undefined);
}

/** The last one made, for showing a card straight away. */
export const savedMix = (id: MixId) => loadJson<Mix | null>(KEY(id), null);
