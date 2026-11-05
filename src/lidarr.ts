// Music requests through Lidarr. The address and API key are the user's own, stored on this device.
import { fetch } from "@tauri-apps/plugin-http";
import { useSettings } from "./store";

export interface LidarrArtist {
  foreignArtistId: string;
  artistName: string;
  overview?: string;
  images?: { coverType: string; remoteUrl?: string; url?: string }[];
  id?: number;
  [k: string]: unknown;
}

export interface LidarrAlbum {
  foreignAlbumId: string;
  title: string;
  releaseDate?: string;
  albumType?: string;
  artist: LidarrArtist;
  images?: { coverType: string; remoteUrl?: string; url?: string }[];
  id?: number;
  monitored?: boolean;
  [k: string]: unknown;
}

async function call<T>(path: string, init: { method?: string; body?: unknown } = {}, cfg = useSettings.getState()): Promise<T> {
  const base = cfg.lidarrUrl.trim().replace(/\/+$/, "");
  if (!base || !cfg.lidarrKey.trim()) throw new Error("Add your Lidarr address and API key in Settings");
  const r = await fetch(`${base}/api/v1${path}`, {
    method: init.method ?? "GET",
    headers: { "X-Api-Key": cfg.lidarrKey.trim(), "Content-Type": "application/json", Accept: "application/json" },
    body: init.body ? JSON.stringify(init.body) : undefined,
    connectTimeout: 8000,
  });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    let detail = text.slice(0, 200);
    try {
      const j = JSON.parse(text);
      detail = Array.isArray(j) ? j.map((e) => e.errorMessage).filter(Boolean).join("; ") : j.message ?? detail;
    } catch {
      /* not JSON */
    }
    throw new Error(r.status === 401 ? "Lidarr rejected the API key" : `Lidarr: ${detail || r.status}`);
  }
  return r.json();
}

export const lidarrConfigured = () => {
  const s = useSettings.getState();
  return !!(s.lidarrUrl.trim() && s.lidarrKey.trim());
};

export interface LidarrOptions {
  roots: { path: string }[];
  quality: { id: number; name: string }[];
  metadata: { id: number; name: string }[];
}

/** Checks the connection and returns what to choose from for new requests. */
export async function lidarrOptions(): Promise<LidarrOptions> {
  const [roots, quality, metadata] = await Promise.all([
    call<{ path: string }[]>("/rootfolder"),
    call<{ id: number; name: string }[]>("/qualityprofile"),
    call<{ id: number; name: string }[]>("/metadataprofile"),
  ]);
  return { roots, quality, metadata };
}

export const lookupArtists = (term: string) => call<LidarrArtist[]>(`/artist/lookup?term=${encodeURIComponent(term)}`);
export const lookupAlbums = (term: string) => call<LidarrAlbum[]>(`/album/lookup?term=${encodeURIComponent(term)}`);

/** Saved choices, or the first of each that Lidarr offers. */
async function defaults() {
  const s = useSettings.getState();
  if (s.lidarrRoot && s.lidarrQuality && s.lidarrMetadata) return { root: s.lidarrRoot, quality: s.lidarrQuality, metadata: s.lidarrMetadata };
  const o = await lidarrOptions();
  if (!o.roots[0] || !o.quality[0] || !o.metadata[0]) throw new Error("Set up a root folder and profiles in Lidarr first");
  return { root: s.lidarrRoot || o.roots[0].path, quality: s.lidarrQuality || o.quality[0].id, metadata: s.lidarrMetadata || o.metadata[0].id };
}

const artistFields = (a: LidarrArtist, d: { root: string; quality: number; metadata: number }) => ({
  ...a,
  qualityProfileId: d.quality,
  metadataProfileId: d.metadata,
  rootFolderPath: d.root,
  monitored: true,
});

export async function requestArtist(a: LidarrArtist) {
  if (a.id) throw new Error(`${a.artistName} is already in Lidarr`);
  const d = await defaults();
  return call("/artist", {
    method: "POST",
    body: { ...artistFields(a, d), addOptions: { monitor: "all", searchForMissingAlbums: true } },
  });
}

export async function requestAlbum(al: LidarrAlbum) {
  const d = await defaults();
  if (al.id) {
    // Already known to Lidarr: monitor it and search for it.
    await call("/album/monitor", { method: "PUT", body: { albumIds: [al.id], monitored: true } });
    await call("/command", { method: "POST", body: { name: "AlbumSearch", albumIds: [al.id] } });
    return;
  }
  return call("/album", {
    method: "POST",
    body: {
      ...al,
      monitored: true,
      artist: { ...artistFields(al.artist, d), monitored: !!al.artist.id, addOptions: { monitor: "none", searchForMissingAlbums: false } },
      addOptions: { searchForNewAlbum: true },
    },
  });
}

export function lidarrImage(item: { images?: { coverType: string; remoteUrl?: string; url?: string }[] }) {
  const img = item.images?.find((i) => i.coverType === "cover" || i.coverType === "poster") ?? item.images?.[0];
  return img?.remoteUrl;
}
