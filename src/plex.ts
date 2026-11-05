// Plex API client: plex.tv account/PIN auth, server discovery and the
// music-library endpoints. All requests go through the Tauri HTTP plugin so
// CORS and self-signed LAN setups don't get in the way.
import { fetch } from "@tauri-apps/plugin-http";
import { convertFileSrc } from "@tauri-apps/api/core";
import { isAndroid } from "./platform";

export const PRODUCT = "Platter";
/** Earlier versions called themselves Tonearm; they speak the same protocol. */
export const isOurs = (product: string | undefined) => product === PRODUCT || product === "Tonearm";
export const VERSION = "0.3.5";

export function clientId(): string {
  let id = localStorage.getItem("tonearm.clientId");
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem("tonearm.clientId", id);
  }
  return id;
}

let plexDeviceName: string = PRODUCT;

/** What Plex shows in its activity list and dashboard: "Platter - <device name>". */
export function setPlexDeviceName(name: string) {
  plexDeviceName = name ? `${PRODUCT} - ${name}` : PRODUCT;
}

export function plexHeaders(token?: string): Record<string, string> {
  const platform = isAndroid() ? "Android" : "Linux";
  const h: Record<string, string> = {
    Accept: "application/json",
    "X-Plex-Client-Identifier": clientId(),
    "X-Plex-Product": PRODUCT,
    "X-Plex-Version": VERSION,
    "X-Plex-Platform": platform,
    "X-Plex-Device": platform,
    "X-Plex-Device-Name": plexDeviceName,
    "X-Plex-Provides": "player",
  };
  if (token) h["X-Plex-Token"] = token;
  return h;
}

// ---- plex.tv ---------------------------------------------------------------

// Test builds talk to the stand-in server instead (see tests/mock-plex.mjs).
const PLEX_TV = (import.meta.env.VITE_TEST_PLEX as string | undefined) ?? "https://plex.tv";

async function plexTv<T>(path: string, opts: { method?: string; token?: string } = {}): Promise<T> {
  const r = await fetch(PLEX_TV + path, {
    method: opts.method ?? "GET",
    headers: plexHeaders(opts.token),
  });
  if (!r.ok) throw new Error(`plex.tv returned ${r.status}`);
  return r.json();
}

export const createPin = () => plexTv<{ id: number; code: string }>("/api/v2/pins?strong=true", { method: "POST" });

export function authUrl(code: string) {
  const p = new URLSearchParams({
    clientID: clientId(),
    code,
    "context[device][product]": PRODUCT,
  });
  return `https://app.plex.tv/auth#?${p}`;
}

export async function checkPin(id: number): Promise<string | null> {
  const r = await plexTv<{ authToken: string | null }>(`/api/v2/pins/${id}`);
  return r.authToken;
}

export interface PlexUser {
  uuid?: string;
  username: string;
  title: string;
  thumb?: string;
}
export const getUser = (token: string) => plexTv<PlexUser>("/api/v2/user", { token });

export interface Connection {
  uri: string;
  local: boolean;
  relay: boolean;
  protocol: string;
  address?: string;
  port?: number;
}
export interface Resource {
  name: string;
  clientIdentifier: string;
  accessToken: string;
  provides: string;
  product: string;
  platform: string;
  owned: boolean;
  presence: boolean;
  connections: Connection[];
}

export async function getServers(token: string): Promise<Resource[]> {
  const rs = await plexTv<Resource[]>("/api/v2/resources?includeHttps=1&includeRelay=1&includeIPv6=1", { token });
  return rs.filter((r) => r.provides.split(",").includes("server"));
}

/** Other Platters on this account that have published an address. */
export async function getPlayers(token: string): Promise<Resource[]> {
  const rs = await plexTv<Resource[]>("/api/v2/resources", { token });
  return rs.filter((r) => isOurs(r.product) && r.clientIdentifier !== clientId() && r.connections?.length);
}

/** Lists this device's address on the Plex account, as Plex's own players do. */
export async function publishConnection(token: string, uri: string) {
  const q = new URLSearchParams({ "Connection[][uri]": uri });
  const r = await fetch(`${PLEX_TV}/devices/${clientId()}?${q}`, { method: "PUT", headers: { ...plexHeaders(token), "X-Plex-Provides": "player" } });
  if (!r.ok) throw new Error(`plex.tv returned ${r.status}`);
}

// ---- library model ---------------------------------------------------------

export interface Track {
  ratingKey: string;
  title: string;
  artist: string;
  artistKey?: string;
  album: string;
  albumKey?: string;
  thumb?: string;
  duration: number; // ms
  partKey?: string;
  index?: number;
  disc?: number;
  year?: number;
  userRating?: number;
  codec?: string;
  bitrate?: number;
  playlistItemID?: number;
  sampleRate?: number;
  bitDepth?: number;
  /** Path of a file on this device; such tracks have keys starting "local". */
  local?: string;
  downloaded?: boolean;
  /** Loudness correction in dB, from tags or Plex's analysis. */
  gain?: number;
  albumGain?: number;
  /** Where playback stopped last time, on any Plex player (ms). */
  viewOffset?: number;
  lastViewedAt?: number; // unix seconds
}

export interface Album {
  ratingKey: string;
  title: string;
  artist: string;
  artistKey?: string;
  thumb?: string;
  year?: number;
  addedAt?: number;
  userRating?: number;
  summary?: string;
  genres?: string[];
  studio?: string;
  leafCount?: number;
  format?: string;
}

export interface Artist {
  ratingKey: string;
  title: string;
  thumb?: string;
  art?: string;
  summary?: string;
  genres?: string[];
  similar?: string[];
}

export interface Playlist {
  ratingKey: string;
  title: string;
  leafCount: number;
  duration: number;
  smart: boolean;
  thumb?: string;
}

export interface Hub {
  title: string;
  type: string;
  hubIdentifier: string;
  items: (Album | Artist | Track | Playlist)[];
  itemType: string;
  /** Plex's address for the hub's full listing. */
  path?: string;
  /** The hub has more items than it came with. */
  more?: boolean;
}

/** How many results a search returns per type, unless asked for more. */
export const SEARCH_LIMIT = 8;

const tags = (xs?: { tag: string }[]) => xs?.map((x) => x.tag);

/** "FLAC", "MP3", "WAV"… from the codec Plex reports or the file extension. */
export function fileType(t: Pick<Track, "codec" | "partKey">) {
  const raw = t.codec || t.partKey?.split("?")[0].split(".").pop() || "";
  const c = raw.toLowerCase();
  if (!c || c.length > 8 || c.includes("/")) return "";
  return ({ pcm: "WAV", wave: "WAV", aac: "AAC", m4a: "AAC", vorbis: "OGG", ogg: "OGG", mp3: "MP3", alac: "ALAC", opus: "OPUS", dca: "DTS" } as Record<string, string>)[c] ?? c.toUpperCase();
}

export function toTrack(m: any): Track {
  const media = m.Media?.[0];
  const part = media?.Part?.[0];
  return {
    ratingKey: String(m.ratingKey),
    title: m.title,
    artist: m.originalTitle || m.grandparentTitle || "Unknown artist",
    artistKey: m.grandparentRatingKey ? String(m.grandparentRatingKey) : undefined,
    album: m.parentTitle || "",
    albumKey: m.parentRatingKey ? String(m.parentRatingKey) : undefined,
    thumb: m.parentThumb || m.thumb || m.grandparentThumb,
    duration: m.duration ?? media?.duration ?? 0,
    partKey: part?.key,
    index: m.index,
    disc: m.parentIndex,
    year: m.parentYear ?? m.year,
    userRating: m.userRating,
    codec: media?.audioCodec,
    bitrate: media?.bitrate,
    playlistItemID: m.playlistItemID,
    viewOffset: m.viewOffset,
    lastViewedAt: m.lastViewedAt,
  };
}

export function toAlbum(m: any): Album {
  const format = m.Subformat?.[0]?.tag ?? m.Format?.[0]?.tag;
  return {
    ratingKey: String(m.ratingKey),
    title: m.title,
    artist: m.parentTitle || "Unknown artist",
    artistKey: m.parentRatingKey ? String(m.parentRatingKey) : undefined,
    thumb: m.thumb,
    year: m.year,
    addedAt: m.addedAt,
    userRating: m.userRating,
    summary: m.summary,
    genres: tags(m.Genre),
    studio: m.studio,
    leafCount: m.leafCount,
    format,
  };
}

export function toArtist(m: any): Artist {
  return {
    ratingKey: String(m.ratingKey),
    title: m.title,
    thumb: m.thumb,
    art: m.art,
    summary: m.summary,
    genres: tags(m.Genre),
    similar: tags(m.Similar),
  };
}

export function toPlaylist(m: any): Playlist {
  return {
    ratingKey: String(m.ratingKey),
    title: m.title,
    leafCount: m.leafCount ?? 0,
    duration: m.duration ?? 0,
    smart: !!m.smart,
    thumb: m.composite || m.thumb,
  };
}

export function convert(m: any): Album | Artist | Track | Playlist {
  switch (m.type) {
    case "track":
      return toTrack(m);
    case "album":
      return toAlbum(m);
    case "artist":
      return toArtist(m);
    case "playlist":
      return toPlaylist(m);
    default:
      return toAlbum(m);
  }
}

// ---- server ----------------------------------------------------------------

export interface LocalProvider {
  album(key: string): Album;
  albumTracks(key: string): Track[];
  artist(key: string): Artist;
  artistAlbums(key: string): Album[];
  artistTracks(key: string): Track[];
  search(query: string, plex: Hub[], limit: number): Hub[];
  shelf(): Hub | null;
}

/** Answers for music on this device; see local.ts. */
let local: LocalProvider | null = null;
export const setLocalProvider = (p: LocalProvider) => (local = p);
const isLocal = (key: string) => key.startsWith("local");

export interface ServerInfo {
  uri: string;
  token: string;
  machineId: string;
  name: string;
  local: boolean;
  /** Every address the server advertises, so switching networks is instant. */
  connections?: Connection[];
}

type Params = Record<string, string | number | undefined>;

export class Server {
  constructor(public info: ServerInfo) {}

  url(path: string, params: Params = {}) {
    const u = new URL(this.info.uri + path);
    for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, String(v));
    return u.toString();
  }

  async request<T = any>(path: string, params: Params = {}, method = "GET"): Promise<T> {
    const r = await fetch(this.url(path, params), { method, headers: plexHeaders(this.info.token) });
    if (!r.ok) throw new Error(`Plex returned ${r.status} for ${path}`);
    const text = await r.text();
    return text ? JSON.parse(text) : ({} as T);
  }

  async container(path: string, params: Params = {}) {
    const j = await this.request(path, params);
    return j.MediaContainer ?? {};
  }

  imageUrl(thumb: string | undefined, size = 300) {
    if (!thumb) return undefined;
    if (thumb.startsWith("local-cover:")) return convertFileSrc(thumb.slice(12));
    return this.url("/photo/:/transcode", {
      width: size,
      height: size,
      minSize: 1,
      upscale: 1,
      url: thumb,
      "X-Plex-Token": this.info.token,
    });
  }

  streamUrl(t: Track, transcodeKbps: number | null, session: string) {
    if (!transcodeKbps && t.partKey) {
      return this.url(t.partKey, { "X-Plex-Token": this.info.token });
    }
    return this.url("/music/:/transcode/universal/start.mp3", {
      path: `/library/metadata/${t.ratingKey}`,
      mediaIndex: 0,
      partIndex: 0,
      protocol: "http",
      directPlay: 0,
      directStream: 0,
      hasMDE: 1,
      maxAudioBitrate: transcodeKbps ?? 320,
      musicBitrate: transcodeKbps ?? 320,
      session,
      "X-Plex-Session-Identifier": session,
      "X-Plex-Client-Identifier": clientId(),
      "X-Plex-Product": PRODUCT,
      "X-Plex-Platform": "Chrome",
      "X-Plex-Token": this.info.token,
    });
  }

  // ---- library ----

  async musicSections(): Promise<{ key: string; title: string }[]> {
    const c = await this.container("/library/sections");
    return (c.Directory ?? []).filter((d: any) => d.type === "artist").map((d: any) => ({ key: String(d.key), title: d.title }));
  }

  async page(path: string, params: Params, start: number, size: number) {
    const c = await this.container(path, { ...params, "X-Plex-Container-Start": start, "X-Plex-Container-Size": size });
    return { items: (c.Metadata ?? []) as any[], total: (c.totalSize ?? c.size ?? 0) as number };
  }

  async artists(section: string, sort: string, start: number, size: number) {
    const p = await this.page(`/library/sections/${section}/all`, { type: 8, sort }, start, size);
    return { items: p.items.map(toArtist), total: p.total };
  }

  async albums(section: string, opts: { sort: string; genre?: string; unplayed?: boolean }, start: number, size: number) {
    const p = await this.page(
      `/library/sections/${section}/all`,
      { type: 9, sort: opts.sort, genre: opts.genre, "album.viewCount": opts.unplayed ? 0 : undefined },
      start,
      size,
    );
    return { items: p.items.map(toAlbum), total: p.total };
  }

  async genres(section: string): Promise<{ key: string; title: string }[]> {
    const c = await this.container(`/library/sections/${section}/genre`, { type: 9 });
    return (c.Directory ?? []).map((d: any) => ({ key: String(d.key), title: d.title }));
  }

  async hubs(section: string): Promise<Hub[]> {
    const shelf = local?.shelf();
    let hubs: Hub[];
    try {
      const c = await this.container(`/hubs/sections/${section}`, { count: 16, includeLibraryPlaylists: 1 });
      hubs = (c.Hub ?? [])
        .filter((h: any) => h.Metadata?.length)
        .map((h: any) => ({
          title: h.title,
          type: h.type,
          hubIdentifier: h.hubIdentifier,
          itemType: h.Metadata[0]?.type ?? h.type,
          items: h.Metadata.map(convert),
          path: h.key?.startsWith("/") ? h.key : undefined,
          more: !!h.more,
        }));
    } catch (e) {
      // Offline: what's on this device still works.
      if (!shelf) throw e;
      hubs = [];
    }
    return shelf ? [shelf, ...hubs] : hubs;
  }

  /** One page of a hub's full listing. */
  async hubItems(path: string, start: number, size: number) {
    const c = await this.container(path, { "X-Plex-Container-Start": start, "X-Plex-Container-Size": size });
    const hub = c.Hub?.[0];
    const items = ((c.Metadata ?? hub?.Metadata ?? []) as any[]).map(convert);
    // Not every listing reports a total, and then there's no telling whether a next page exists.
    return { items, total: (c.totalSize ?? hub?.totalSize ?? start + items.length) as number };
  }

  async randomAlbums(section: string, count: number) {
    return (await this.albums(section, { sort: "random" }, 0, count)).items;
  }

  async randomTracks(section: string, count: number, filter: Params = {}) {
    const p = await this.page(`/library/sections/${section}/all`, { type: 10, sort: "random", ...filter }, 0, count);
    return p.items.map(toTrack);
  }

  async metadata(key: string) {
    const c = await this.container(`/library/metadata/${key}`);
    return c.Metadata?.[0];
  }

  /** Sonically similar tracks (needs Plex sonic analysis; empty otherwise). */
  async nearest(key: string, limit: number) {
    const c = await this.container(`/library/metadata/${key}/nearest`, { limit, maxDistance: 0.25 });
    return (c.Metadata ?? []).map(toTrack) as Track[];
  }

  async artist(key: string) {
    if (isLocal(key)) return local!.artist(key);
    return toArtist(await this.metadata(key));
  }

  async artistAlbums(key: string) {
    if (isLocal(key)) return local!.artistAlbums(key);
    const c = await this.container(`/library/metadata/${key}/children`, { excludeAllLeaves: 1 });
    return (c.Metadata ?? []).map(toAlbum) as Album[];
  }

  async artistTracks(key: string) {
    if (isLocal(key)) return local!.artistTracks(key);
    const c = await this.container(`/library/metadata/${key}/allLeaves`);
    return (c.Metadata ?? []).map(toTrack) as Track[];
  }

  async popularTracks(section: string, artistKey: string) {
    if (isLocal(artistKey)) return [];
    try {
      const p = await this.page(
        `/library/sections/${section}/all`,
        { type: 10, "artist.id": artistKey, sort: "ratingCount:desc", group: "title" },
        0,
        10,
      );
      return p.items.filter((m) => m.ratingCount).map(toTrack);
    } catch {
      return [];
    }
  }

  async album(key: string) {
    if (isLocal(key)) return local!.album(key);
    return toAlbum(await this.metadata(key));
  }

  async albumTracks(key: string) {
    if (isLocal(key)) return local!.albumTracks(key);
    const c = await this.container(`/library/metadata/${key}/children`);
    return (c.Metadata ?? []).map(toTrack) as Track[];
  }

  async playlists() {
    const c = await this.container("/playlists", { playlistType: "audio" });
    return (c.Metadata ?? []).map(toPlaylist) as Playlist[];
  }

  async playlist(key: string) {
    return toPlaylist(await this.metadata(key));
  }

  async playlistTracks(key: string) {
    const c = await this.container(`/playlists/${key}/items`);
    return (c.Metadata ?? []).map(toTrack) as Track[];
  }

  private itemsUri(keys: string[]) {
    return `server://${this.info.machineId}/com.plexapp.plugins.library/library/metadata/${keys.join(",")}`;
  }

  async createPlaylist(title: string, keys: string[]) {
    const c = await this.request("/playlists", { type: "audio", title, smart: 0, uri: this.itemsUri(keys) }, "POST");
    return toPlaylist(c.MediaContainer.Metadata[0]);
  }

  addToPlaylist(id: string, keys: string[]) {
    return this.request(`/playlists/${id}/items`, { uri: this.itemsUri(keys) }, "PUT");
  }

  removeFromPlaylist(id: string, playlistItemID: number) {
    return this.request(`/playlists/${id}/items/${playlistItemID}`, {}, "DELETE");
  }

  movePlaylistItem(id: string, playlistItemID: number, afterItemID?: number) {
    return this.request(`/playlists/${id}/items/${playlistItemID}/move`, { after: afterItemID }, "PUT");
  }

  deletePlaylist(id: string) {
    return this.request(`/playlists/${id}`, {}, "DELETE");
  }

  renamePlaylist(id: string, title: string) {
    return this.request(`/playlists/${id}`, { title }, "PUT");
  }

  async search(section: string, query: string, limit = SEARCH_LIMIT): Promise<Hub[]> {
    let plex: Hub[] = [];
    try {
      plex = await this.plexSearch(section, query, limit);
    } catch (e) {
      if (!local) throw e;
    }
    return [...(local?.search(query, plex, limit) ?? []), ...plex];
  }

  private async plexSearch(section: string, query: string, limit: number): Promise<Hub[]> {
    const c = await this.container("/hubs/search", { query, sectionId: section, limit });
    return (c.Hub ?? [])
      .filter((h: any) => h.Metadata?.length && ["artist", "album", "track", "playlist"].includes(h.type))
      .map((h: any) => ({
        title: h.title,
        type: h.type,
        hubIdentifier: h.hubIdentifier,
        itemType: h.type,
        items: h.Metadata.map(convert),
      }));
  }

  rate(key: string, rating: number | null) {
    if (isLocal(key)) return Promise.resolve();
    return this.request(
      "/:/rate",
      { key, identifier: "com.plexapp.plugins.library", rating: rating ?? -1 },
      "PUT",
    );
  }

  /**
   * Reports playback so Plex shows it under Now Playing and remembers the position (viewOffset),
   * which other Plex apps and Platter on other devices resume from.
   */
  timeline(t: Track, state: "playing" | "paused" | "stopped", timeMs: number, session: string) {
    if (isLocal(t.ratingKey)) return Promise.resolve(undefined);
    const params = {
      ratingKey: t.ratingKey,
      key: `/library/metadata/${t.ratingKey}`,
      identifier: "com.plexapp.plugins.library",
      state,
      time: Math.round(timeMs),
      duration: t.duration,
      hasMDE: 1,
    };
    return fetch(this.url("/:/timeline", params), {
      headers: { ...plexHeaders(this.info.token), "X-Plex-Session-Identifier": session },
      keepalive: state === "stopped",
    }).catch(() => undefined);
  }

  /** The track most recently played on any of the user's Plex players. */
  async lastPlayed(section: string): Promise<Track | null> {
    const c = await this.container(`/library/sections/${section}/all`, {
      type: 10,
      sort: "lastViewedAt:desc",
      "X-Plex-Container-Start": 0,
      "X-Plex-Container-Size": 1,
    });
    const m = c.Metadata?.[0];
    return m ? toTrack(m) : null;
  }

  scrobble(key: string) {
    if (isLocal(key)) return Promise.resolve(undefined);
    return this.request("/:/scrobble", { key, identifier: "com.plexapp.plugins.library" }).catch(() => undefined);
  }

  /** Streams (lyrics, audio) for a track; the list endpoints don't include them. */
  async trackStreams(key: string): Promise<any[]> {
    if (isLocal(key)) return [];
    const m = await this.metadata(key);
    return m?.Media?.[0]?.Part?.[0]?.Stream ?? [];
  }

  async rawText(path: string): Promise<string> {
    const r = await fetch(this.url(path, { "X-Plex-Token": this.info.token }), { headers: plexHeaders(this.info.token) });
    if (!r.ok) throw new Error(String(r.status));
    return r.text();
  }

  /** Loudness samples from sonic analysis, used to draw the waveform seek bar. */
  async levels(audioStreamId: number, samples = 160): Promise<number[]> {
    const c = await this.container(`/library/streams/${audioStreamId}/levels`, { subsample: samples });
    return (c.Level ?? []).map((l: any) => Number(l.v ?? l.loudness ?? -60));
  }
}
