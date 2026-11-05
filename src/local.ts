// Music on this device: scanned folders and downloads. Local tracks look like Plex tracks to the
// rest of the app, with keys starting "local". When the same song exists both locally and on
// Plex, the Plex listing stays (so play counts still sync) but the local file is what plays; among
// several local copies the best quality wins and only that one is listed.
import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { Album, Artist, Hub, Track, setLocalProvider } from "./plex";
import { server, toast, useSettings } from "./store";
import { searchRecordings } from "./musicbrainz";

export interface LocalFile {
  path: string;
  mtime: number;
  size: number;
  title: string;
  artist: string;
  albumArtist: string;
  album: string;
  track: number | null;
  disc: number | null;
  year: number | null;
  genre: string;
  duration: number;
  bitrate: number;
  sampleRate: number;
  bitDepth: number;
  codec: string;
  gain: number | null;
  albumGain: number | null;
  cover: string | null;
  tagged: boolean;
}

export type TagFields = Pick<LocalFile, "title" | "artist" | "albumArtist" | "album" | "track" | "disc" | "year" | "genre">;

interface LocalState {
  files: LocalFile[];
  /** Edits and online matches, applied on top of what's in the file. */
  overrides: Record<string, Partial<LocalFile>>;
  tracks: Track[];
  albums: Album[];
  artists: Artist[];
  scanning: boolean;
  scanned: number;
  downloading: number;
}

export const useLocal = create<LocalState>(() => ({
  files: [], overrides: {}, tracks: [], albums: [], artists: [], scanning: false, scanned: 0, downloading: 0,
}));

export const isLocalKey = (key: string | undefined) => !!key?.startsWith("local");

function hash(s: string) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36) + s.length.toString(36);
}

const norm = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");

const LOSSLESS = new Set(["flac", "alac", "wav", "wave", "pcm", "aif", "aiff", "ape", "wv"]);

/** Bigger is better: lossless first, then resolution, then bitrate. */
function quality(t: Track) {
  const lossless = LOSSLESS.has((t.codec ?? "").toLowerCase()) ? 1 : 0;
  return lossless * 1e9 + (t.bitDepth ?? 0) * 1e6 + (t.sampleRate ?? 0) + (t.bitrate ?? 0);
}

let downloadsPath = "";
/** normalised "artist|title" → local copies, best first. */
let byIdentity = new Map<string, Track[]>();

function toTrack(f: LocalFile): Track {
  const albumOwner = f.albumArtist || f.artist;
  return {
    ratingKey: `local:${hash(f.path)}`,
    title: f.title,
    artist: f.artist || "Unknown artist",
    artistKey: `localartist:${hash(norm(albumOwner) || "unknown")}`,
    album: f.album,
    albumKey: `localalbum:${hash(norm(albumOwner) + "|" + norm(f.album))}`,
    thumb: f.cover ? `local-cover:${f.cover}` : undefined,
    duration: f.duration,
    index: f.track ?? undefined,
    disc: f.disc ?? undefined,
    year: f.year ?? undefined,
    codec: f.codec,
    bitrate: f.bitrate,
    sampleRate: f.sampleRate,
    bitDepth: f.bitDepth,
    local: f.path,
    gain: f.gain ?? undefined,
    albumGain: f.albumGain ?? undefined,
    downloaded: !!downloadsPath && f.path.startsWith(downloadsPath),
  };
}

const closeEnough = (a: Track, b: Track) => !a.duration || !b.duration || Math.abs(a.duration - b.duration) < 5000;

function rebuild() {
  const { files, overrides } = useLocal.getState();
  const all = files.map((f) => toTrack({ ...f, ...overrides[f.path] }));
  byIdentity = new Map();
  for (const t of all) {
    const k = `${norm(t.artist)}|${norm(t.title)}`;
    const list = byIdentity.get(k);
    if (list) list.push(t);
    else byIdentity.set(k, [t]);
  }
  // Only the best copy of each song is listed.
  const tracks: Track[] = [];
  for (const list of byIdentity.values()) {
    list.sort((a, b) => quality(b) - quality(a));
    tracks.push(...list.filter((t, i) => !list.slice(0, i).some((better) => closeEnough(better, t))));
  }
  const albums = new Map<string, Album>();
  const artists = new Map<string, Artist>();
  const ordered = [...tracks].sort((a, b) => a.album.localeCompare(b.album) || (a.disc ?? 1) - (b.disc ?? 1) || (a.index ?? 0) - (b.index ?? 0));
  for (const t of ordered) {
    const f = overrides[t.local!]?.albumArtist || files.find((x) => x.path === t.local)?.albumArtist;
    const owner = f || t.artist;
    const al = albums.get(t.albumKey!);
    if (al) al.leafCount = (al.leafCount ?? 0) + 1;
    else albums.set(t.albumKey!, { ratingKey: t.albumKey!, title: t.album, artist: owner, artistKey: t.artistKey, thumb: t.thumb, year: t.year, leafCount: 1 });
    if (!artists.has(t.artistKey!)) artists.set(t.artistKey!, { ratingKey: t.artistKey!, title: owner, thumb: t.thumb });
  }
  useLocal.setState({
    tracks: ordered,
    albums: [...albums.values()].sort((a, b) => a.title.localeCompare(b.title)),
    artists: [...artists.values()].sort((a, b) => a.title.localeCompare(b.title)),
  });
}

/** The best local copy of a Plex track, if there is one. */
export function localMatch(t: Track): Track | null {
  if (t.local) return t;
  const list = byIdentity.get(`${norm(t.artist)}|${norm(t.title)}`);
  return list?.find((c) => closeEnough(c, t)) ?? null;
}

// ---- index persistence -----------------------------------------------------------------------

let saveTimer = 0;
function save() {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    const { files, overrides } = useLocal.getState();
    void invoke("local_index_save", { json: JSON.stringify({ files, overrides }) }).catch((e) => console.warn("local index", e));
  }, 500);
}

export async function initLocal() {
  downloadsPath = await invoke<string>("downloads_dir").catch(() => "");
  const raw = await invoke<string>("local_index_load").catch(() => "");
  if (raw) {
    try {
      const j = JSON.parse(raw);
      useLocal.setState({ files: j.files ?? [], overrides: j.overrides ?? {} });
      rebuild();
    } catch {
      /* a corrupt index just means a full rescan */
    }
  }
  void scanLocal();
}

// ---- scanning ---------------------------------------------------------------------------------

export async function scanLocal(manual = false) {
  if (useLocal.getState().scanning) return;
  const folders = [...useSettings.getState().localFolders, ...(downloadsPath ? [downloadsPath] : [])];
  useLocal.setState({ scanning: true, scanned: 0 });
  try {
    const known = Object.fromEntries(useLocal.getState().files.map((f) => [f.path, f.mtime]));
    const r = await invoke<{ changed: LocalFile[]; present: string[] }>("local_scan", { folders, known });
    const present = new Set(r.present);
    const changed = new Map(r.changed.map((f) => [f.path, f]));
    const kept = useLocal.getState().files.filter((f) => present.has(f.path) && !changed.has(f.path));
    useLocal.setState({ files: [...kept, ...r.changed] });
    rebuild();
    save();
    if (manual) toast(`Found ${useLocal.getState().tracks.length.toLocaleString()} tracks on this device`);
    void autoMatch();
  } catch (e) {
    toast(`Couldn't scan your folders: ${e}`, { error: true });
  } finally {
    useLocal.setState({ scanning: false });
  }
}

const tried = new Set<string>();
let matching = false;

/** Files without usable tags: ask MusicBrainz, one request a second as its rules require. */
async function autoMatch() {
  if (matching || !useSettings.getState().localAutoMatch) return;
  matching = true;
  try {
    for (const f of useLocal.getState().files) {
      const o = useLocal.getState().overrides[f.path];
      // A title alone matches too many songs to trust without asking.
      if (f.tagged || o?.title || !f.artist || !f.title || tried.has(f.path) || (downloadsPath && f.path.startsWith(downloadsPath))) continue;
      tried.add(f.path);
      const results = await searchRecordings(f.artist, f.title).catch(() => []);
      const hit = results[0];
      if (hit && hit.score >= 90) {
        applyOverride(f.path, { title: hit.title, artist: hit.artist, album: hit.album || f.album, year: hit.year ?? f.year, track: hit.track ?? f.track, tagged: true });
      }
      await new Promise((r) => setTimeout(r, 1100));
    }
  } finally {
    matching = false;
  }
}

function applyOverride(path: string, patch: Partial<LocalFile>) {
  useLocal.setState((s) => ({ overrides: { ...s.overrides, [path]: { ...s.overrides[path], ...patch } } }));
  rebuild();
  save();
}

// ---- editing ----------------------------------------------------------------------------------

export function fieldsFor(path: string): TagFields | null {
  const { files, overrides } = useLocal.getState();
  const f = files.find((x) => x.path === path);
  if (!f) return null;
  const m = { ...f, ...overrides[path] };
  return { title: m.title, artist: m.artist, albumArtist: m.albumArtist, album: m.album, track: m.track, disc: m.disc, year: m.year, genre: m.genre };
}

/**
 * Saves edits into the file's tags. If the file can't be written (read-only, or Android's storage
 * rules), the edit is still kept inside Platter. Returns whether the file itself was updated.
 */
export async function saveTags(path: string, tags: TagFields, coverUrl?: string) {
  let written = true;
  try {
    await invoke("local_write_tags", { path, tags });
  } catch (e) {
    console.warn("write tags", e);
    written = false;
  }
  const patch: Partial<LocalFile> = { ...tags, tagged: true };
  if (coverUrl) {
    const cover = await invoke<string>("local_set_cover", { path, url: coverUrl }).catch(() => null);
    if (cover) patch.cover = cover;
  }
  applyOverride(path, patch);
  return written;
}

// ---- folders ------------------------------------------------------------------------------------

export function addFolder(path: string) {
  const s = useSettings.getState();
  const clean = path.trim().replace(/\/+$/, "");
  if (!clean || s.localFolders.includes(clean)) return;
  s.set({ localFolders: [...s.localFolders, clean] });
  void scanLocal(true);
}

export function removeFolder(path: string) {
  const s = useSettings.getState();
  s.set({ localFolders: s.localFolders.filter((f) => f !== path) });
  void scanLocal();
}

// ---- downloads ----------------------------------------------------------------------------------

export const isDownloaded = (t: Track) => !!localMatch(t)?.downloaded;

export async function downloadTracks(tracks: Track[]) {
  const todo = tracks.filter((t) => !localMatch(t) && t.partKey);
  if (!todo.length) return toast(tracks.length === 1 ? "Already on this device" : "Those are already on this device");
  toast(todo.length === 1 ? `Downloading “${todo[0].title}”…` : `Downloading ${todo.length} tracks…`);
  useLocal.setState((s) => ({ downloading: s.downloading + todo.length }));
  let failed = 0;
  for (const t of todo) {
    try {
      const url = server().url(t.partKey!, { "X-Plex-Token": server().info.token });
      const ext = t.partKey!.split("?")[0].split(".").pop() || "audio";
      const name = `${t.index ? String(t.index).padStart(2, "0") + " " : ""}${t.title}`;
      const path = await invoke<string>("download_track", { url, artist: t.artist, album: t.album || "Singles", name, ext });
      // Plex's metadata is what the match needs, whatever the file's own tags say.
      applyOverride(path, { title: t.title, artist: t.artist, album: t.album, track: t.index ?? null, disc: t.disc ?? null, year: t.year ?? null, tagged: true });
      if (t.thumb) void applyPlexCover(path, t.thumb);
    } catch (e) {
      console.warn("download", t.title, e);
      failed++;
    }
    useLocal.setState((s) => ({ downloading: s.downloading - 1 }));
  }
  await scanLocal();
  toast(failed ? `${failed} of ${todo.length} downloads failed` : todo.length === 1 ? "Downloaded" : `Downloaded ${todo.length} tracks`, { error: failed > 0 });
}

async function applyPlexCover(path: string, thumb: string) {
  const url = server().imageUrl(thumb, 600);
  if (!url) return;
  const cover = await invoke<string>("local_set_cover", { path, url }).catch(() => null);
  if (cover) applyOverride(path, { cover });
}

export async function removeDownloads(tracks: Track[]) {
  for (const t of tracks) {
    const m = localMatch(t);
    if (m?.downloaded) await invoke("download_delete", { path: m.local }).catch(() => undefined);
  }
  await scanLocal();
  toast("Removed from this device");
}

// ---- what the Plex client asks for local keys ---------------------------------------------------

setLocalProvider({
  album(key) {
    const a = useLocal.getState().albums.find((x) => x.ratingKey === key);
    if (!a) throw new Error("This album is no longer on this device");
    return a;
  },
  albumTracks(key) {
    return useLocal.getState().tracks.filter((t) => t.albumKey === key);
  },
  artist(key) {
    const a = useLocal.getState().artists.find((x) => x.ratingKey === key);
    if (!a) throw new Error("This artist is no longer on this device");
    return a;
  },
  artistAlbums(key) {
    return useLocal.getState().albums.filter((a) => a.artistKey === key);
  },
  artistTracks(key) {
    return useLocal.getState().tracks.filter((t) => t.artistKey === key);
  },
  /** Local results, minus anything the Plex results already list. */
  search(query, plex, limit): Hub[] {
    const q = norm(query);
    if (!q) return [];
    const { tracks, albums, artists } = useLocal.getState();
    const plexTracks = plex.filter((h) => h.type === "track").flatMap((h) => h.items as Track[]);
    const plexAlbums = new Set(plex.filter((h) => h.type === "album").flatMap((h) => h.items.map((a) => norm(a.title))));
    const hubs: Hub[] = [];
    const add = (type: string, title: string, items: Hub["items"]) =>
      items.length && hubs.push({ title, type, itemType: type, hubIdentifier: `local-${type}`, items: items.slice(0, limit) });
    add("track", "Tracks on this device", tracks.filter((t) => norm(`${t.title} ${t.artist}`).includes(q) && !plexTracks.some((p) => localMatch(p)?.ratingKey === t.ratingKey)));
    add("album", "Albums on this device", albums.filter((a) => norm(`${a.title} ${a.artist}`).includes(q) && !plexAlbums.has(norm(a.title))));
    add("artist", "Artists on this device", artists.filter((a) => norm(a.title).includes(q)));
    return hubs;
  },
  shelf(): Hub | null {
    const { albums } = useLocal.getState();
    if (!albums.length) return null;
    return { title: "On this device", type: "album", itemType: "album", hubIdentifier: "local-albums", items: albums.slice(0, 16), more: albums.length > 16 };
  },
});
