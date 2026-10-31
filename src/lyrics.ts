// Lyrics: Plex's own lyric streams first (sidecar .lrc/.txt or LyricFind),
// then LRCLIB as a fallback.
import { fetch } from "@tauri-apps/plugin-http";
import { Track, VERSION } from "./plex";
import { server, useSettings } from "./store";

export interface LyricLine {
  time: number | null; // seconds
  text: string;
}
export interface Lyrics {
  lines: LyricLine[];
  synced: boolean;
  source: string;
}

const cache = new Map<string, Lyrics | null>();

export function parseLrc(text: string): LyricLine[] {
  const out: LyricLine[] = [];
  let offset = 0;
  for (const raw of text.split(/\r?\n/)) {
    const off = raw.match(/^\[offset:\s*([+-]?\d+)\]/i);
    if (off) {
      offset = Number(off[1]) / 1000;
      continue;
    }
    const stamps = [...raw.matchAll(/\[(\d+):(\d+(?:[.:]\d+)?)\]/g)];
    const body = raw.replace(/\[[^\]]*\]/g, "").trim();
    if (!stamps.length) {
      if (body && !/^\[\w+:/.test(raw)) out.push({ time: null, text: body });
      continue;
    }
    for (const m of stamps) {
      out.push({ time: Number(m[1]) * 60 + Number(m[2].replace(":", ".")) - offset, text: body });
    }
  }
  const synced = out.some((l) => l.time !== null);
  if (synced) out.sort((a, b) => (a.time ?? 0) - (b.time ?? 0));
  return out;
}

function fromPlexPayload(text: string): LyricLine[] {
  const t = text.trim();
  if (t.startsWith("{")) {
    const j = JSON.parse(t);
    const lyr = j.MediaContainer?.Lyrics?.[0];
    if (lyr?.Line) {
      return lyr.Line.map((l: any) => ({
        time: l.startOffset != null ? Number(l.startOffset) / 1000 : null,
        text: (l.Span ?? []).map((s: any) => s.text).join("") || "",
      }));
    }
  }
  if (t.startsWith("<")) {
    const doc = new DOMParser().parseFromString(t, "text/xml");
    const lines = [...doc.querySelectorAll("Line")];
    if (lines.length) {
      return lines.map((l) => ({
        time: l.getAttribute("startOffset") ? Number(l.getAttribute("startOffset")) / 1000 : null,
        text: [...l.querySelectorAll("Span")].map((s) => s.getAttribute("text") ?? "").join(""),
      }));
    }
  }
  return parseLrc(t);
}

async function fromPlex(t: Track): Promise<Lyrics | null> {
  const streams = await server().trackStreams(t.ratingKey);
  const lyricStreams = streams.filter((s) => s.streamType === 4 && s.key);
  // Prefer timed lyrics.
  lyricStreams.sort((a, b) => Number(b.codec === "lrc" || b.timed) - Number(a.codec === "lrc" || a.timed));
  for (const s of lyricStreams) {
    try {
      const lines = fromPlexPayload(await server().rawText(s.key)).filter((l, i, a) => l.text || (i > 0 && a[i - 1].text));
      if (lines.length) return { lines, synced: lines.some((l) => l.time !== null), source: s.provider ? "Plex (LyricFind)" : "Plex" };
    } catch {
      /* try next */
    }
  }
  return null;
}

async function fromLrclib(t: Track): Promise<Lyrics | null> {
  const headers = { "Lrclib-Client": `Tonearm v${VERSION}` };
  const params = new URLSearchParams({
    artist_name: t.artist,
    track_name: t.title,
    album_name: t.album,
    duration: String(Math.round(t.duration / 1000)),
  });
  let r = await fetch(`https://lrclib.net/api/get?${params}`, { headers });
  let hit: any = r.ok ? await r.json() : null;
  if (!hit) {
    r = await fetch(`https://lrclib.net/api/search?${new URLSearchParams({ track_name: t.title, artist_name: t.artist })}`, { headers });
    const list: any[] = r.ok ? await r.json() : [];
    hit = list.find((x) => x.syncedLyrics) ?? list[0];
  }
  if (!hit) return null;
  if (hit.instrumental) return { lines: [{ time: null, text: "♪ Instrumental ♪" }], synced: false, source: "LRCLIB" };
  const text = hit.syncedLyrics || hit.plainLyrics;
  if (!text) return null;
  const lines = parseLrc(text);
  return { lines, synced: !!hit.syncedLyrics, source: "LRCLIB" };
}

export async function getLyrics(t: Track): Promise<Lyrics | null> {
  if (cache.has(t.ratingKey)) return cache.get(t.ratingKey)!;
  let result: Lyrics | null = null;
  try {
    result = await fromPlex(t);
  } catch {
    /* fall through */
  }
  if (!result && useSettings.getState().lyricsFallback) {
    try {
      result = await fromLrclib(t);
    } catch {
      /* offline etc. */
    }
  }
  cache.set(t.ratingKey, result);
  return result;
}

export function activeLine(lines: LyricLine[], pos: number) {
  let idx = -1;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].time;
    if (t === null) continue;
    if (t <= pos + 0.15) idx = i;
    else break;
  }
  return idx;
}
