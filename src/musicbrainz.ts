// MusicBrainz lookups for tracks with missing or wrong metadata. Asked for artist and title only.
import { fetch } from "@tauri-apps/plugin-http";

export interface Recording {
  id: string;
  title: string;
  artist: string;
  album: string;
  year: number | null;
  track: number | null;
  releaseId: string | null;
  score: number;
}

const UA = "Platter/0.3 ( https://github.com/NonSpecific44/platter )";

/** Lucene query syntax treats these as operators. */
const esc = (s: string) => s.replace(/([+\-!(){}[\]^"~*?:\\/]|&&|\|\|)/g, "\\$1");

export async function searchRecordings(artist: string, title: string, album = ""): Promise<Recording[]> {
  const parts = [title && `recording:"${esc(title)}"`, artist && `artist:"${esc(artist)}"`, album && `release:"${esc(album)}"`].filter(Boolean);
  if (!parts.length) return [];
  const url = `https://musicbrainz.org/ws/2/recording?fmt=json&limit=12&query=${encodeURIComponent(parts.join(" AND "))}`;
  const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
  if (!r.ok) throw new Error(`MusicBrainz returned ${r.status}`);
  const j = await r.json();
  return (j.recordings ?? []).map((rec: any): Recording => {
    const rel = rec.releases?.[0];
    const year = parseInt(rel?.date ?? rec["first-release-date"] ?? "", 10);
    const number = parseInt(rel?.media?.[0]?.track?.[0]?.number ?? "", 10);
    return {
      id: rec.id,
      title: rec.title,
      artist: (rec["artist-credit"] ?? []).map((c: any) => c.name + (c.joinphrase ?? "")).join(""),
      album: rel?.title ?? "",
      year: Number.isFinite(year) ? year : null,
      track: Number.isFinite(number) ? number : null,
      releaseId: rel?.id ?? null,
      score: rec.score ?? 0,
    };
  });
}

export const coverArtUrl = (releaseId: string) => `https://coverartarchive.org/release/${releaseId}/front-500`;
