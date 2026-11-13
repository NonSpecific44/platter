// Covers for the Made for you mixes, drawn here in the style of Spotify's:
//   daylist: soft, grainy colour that follows the time of day, nudged by the mix's sound, with
//     "daylist" and its name in lower case.
//   Suggestions: a toned photo of an artist in the mix, with the name on a coloured band.
// Each cover is drawn once per mix and kept, so it doesn't change until the mix does.
import { fetch } from "@tauri-apps/plugin-http";
import type { Mix } from "./mixes";
import { loadJson, server } from "./store";

const SIZE = 640;
const FONT = '"Jost Variable", "Jost", system-ui, sans-serif';

/** Colours for each part of the day, warm in the morning to deep at night. */
const DAY_COLOURS: Record<string, string[]> = {
  "early morning": ["#ffcf9c", "#ffe8a3", "#b5ead7", "#ff9a8b"],
  morning: ["#ffd23f", "#ff9f1c", "#7bdff2", "#fff3b0"],
  afternoon: ["#ff7b54", "#ffb26b", "#ffd56b", "#ef476f"],
  evening: ["#ff4d6d", "#c9184a", "#7b2cbf", "#ff9e7a"],
  night: ["#3a0ca3", "#7209b7", "#4361ee", "#4cc9f0"],
  "late night": ["#10002b", "#3c096c", "#5a189a", "#c77dff"],
};
/** Daily Mix-style colours for Suggestions. */
const MIX_COLOURS = ["#e8115b", "#1e3264", "#8d67ab", "#148a08", "#509bf5", "#ff6437", "#ba5d07", "#7358ff", "#0d73ec", "#af2896"];

function hash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Repeatable randomness, so a mix always gets the same cover. */
function seeded(seed: number) {
  let s = seed || 1;
  return () => ((s = Math.imul(s ^ (s >>> 15), 2246822507) ^ Math.imul(s ^ (s >>> 13), 3266489909)) >>> 0) / 4294967296;
}

const partOfDay = (mix: Mix) => Object.keys(DAY_COLOURS).find((p) => mix.period.endsWith(p)) ?? "evening";

function grain(ctx: CanvasRenderingContext2D, rand: () => number, amount: number) {
  const img = ctx.getImageData(0, 0, SIZE, SIZE);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (rand() - 0.5) * amount;
    d[i] += n;
    d[i + 1] += n;
    d[i + 2] += n;
  }
  ctx.putImageData(img, 0, 0);
}

/** How light the cover is around `y` (0 dark to 1 light), for picking readable text. */
function lightness(ctx: CanvasRenderingContext2D, y: number, h: number) {
  const d = ctx.getImageData(0, Math.max(0, y), SIZE, Math.min(h, SIZE - y)).data;
  let sum = 0;
  for (let i = 0; i < d.length; i += 16) sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
  return sum / (d.length / 16) / 255;
}

const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const mixRgb = (a: number[], b: number[], t: number) => a.map((v, i) => v + (b[i] - v) * t);

/** Lines of `text` that fit `width`, at most `max` of them. */
function wrap(ctx: CanvasRenderingContext2D, text: string, width: number, max: number) {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    const next = line ? `${line} ${word}` : word;
    if (ctx.measureText(next).width > width && line) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines.slice(0, max);
}

function drawDaylist(ctx: CanvasRenderingContext2D, mix: Mix) {
  const rand = seeded(hash(mix.title + mix.period));
  const colours = [...DAY_COLOURS[partOfDay(mix)]];
  // The sound adds a colour of its own, so a trip hop evening looks different to a house one.
  const theme = mix.title.replace(/\s*(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday).*$/i, "");
  colours.push(`hsl(${hash(theme) % 360} 80% 62%)`);
  const bg = ctx.createLinearGradient(0, 0, SIZE, SIZE);
  bg.addColorStop(0, colours[0]);
  bg.addColorStop(1, colours[2]);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, SIZE, SIZE);
  // Soft, overlapping glows of each colour that fade out evenly, with no visible edge.
  for (let i = 0; i < 9; i++) {
    const x = rand() * SIZE;
    const y = rand() * SIZE;
    const r = SIZE * (0.4 + rand() * 0.5);
    const blob = ctx.createRadialGradient(x, y, 0, x, y, r);
    blob.addColorStop(0, colours[i % colours.length]);
    blob.addColorStop(1, "rgba(0,0,0,0)");
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = blob;
    ctx.fillRect(0, 0, SIZE, SIZE);
  }
  ctx.globalAlpha = 1;
  grain(ctx, rand, 22);
  // White or near-black text, whichever reads better on this particular cover.
  const ink = (y: number, h: number) => (lightness(ctx, y, h) > 0.62 ? "#161616" : "#ffffff");
  const lines = (() => {
    ctx.font = `500 38px ${FONT}`;
    return wrap(ctx, mix.title.toLowerCase(), SIZE - 88, 3);
  })();
  const top = ink(30, 110);
  const bottom = ink(SIZE - 70 - lines.length * 46, lines.length * 46 + 40);
  ctx.shadowBlur = 14;
  ctx.shadowColor = top === "#ffffff" ? "rgba(0,0,0,0.3)" : "rgba(255,255,255,0.25)";
  ctx.fillStyle = top;
  ctx.font = `700 76px ${FONT}`;
  ctx.fillText("daylist", 44, 112);
  ctx.shadowColor = bottom === "#ffffff" ? "rgba(0,0,0,0.3)" : "rgba(255,255,255,0.25)";
  ctx.fillStyle = bottom;
  ctx.font = `500 38px ${FONT}`;
  lines.forEach((l, i) => ctx.fillText(l, 44, SIZE - 52 - (lines.length - 1 - i) * 46));
  ctx.shadowBlur = 0;
}

async function artistPhoto(mix: Mix): Promise<ImageBitmap | null> {
  // The artist with the most tracks in the mix, among those Plex has a photo for.
  const counts = new Map<string, number>();
  for (const t of mix.tracks) if (t.artistKey && !t.artistKey.startsWith("local")) counts.set(t.artistKey, (counts.get(t.artistKey) ?? 0) + 1);
  const keys = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
  const load = async (thumb?: string) => {
    const url = thumb && server().imageUrl(thumb, SIZE);
    if (!url) return null;
    const r = await fetch(url);
    return r.ok ? await createImageBitmap(await r.blob()) : null;
  };
  for (const key of keys.slice(0, 4)) {
    const photo = await load((await server().artist(key).catch(() => undefined))?.thumb).catch(() => null);
    if (photo) return photo;
  }
  // No artist photos: an album cover from the mix instead.
  for (const t of mix.tracks.slice(0, 4)) {
    if (t.ratingKey.startsWith("local")) continue;
    const cover = await load(t.thumb).catch(() => null);
    if (cover) return cover;
  }
  return null;
}

async function drawSuggestions(ctx: CanvasRenderingContext2D, mix: Mix) {
  const colour = MIX_COLOURS[hash(mix.period + mix.tracks[0]?.ratingKey) % MIX_COLOURS.length];
  const base = rgb(colour);
  // Two tones of the mix's colour: shadows deep, highlights pale.
  const deep = mixRgb(base, [0, 0, 0], 0.65);
  const pale = mixRgb(base, [255, 255, 255], 0.72);
  // A soft background behind photos that are cut-outs.
  ctx.fillStyle = "#b8b8b8";
  ctx.fillRect(0, 0, SIZE, SIZE);
  const photo = await artistPhoto(mix);
  if (photo) {
    const s = Math.max(SIZE / photo.width, SIZE / photo.height);
    ctx.drawImage(photo, (SIZE - photo.width * s) / 2, (SIZE - photo.height * s) / 2, photo.width * s, photo.height * s);
  }
  const img = ctx.getImageData(0, 0, SIZE, SIZE);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const g = Math.min(1, ((0.3 * d[i] + 0.59 * d[i + 1] + 0.11 * d[i + 2]) / 255) * 1.08);
    const c = mixRgb(deep, pale, g);
    d[i] = c[0];
    d[i + 1] = c[1];
    d[i + 2] = c[2];
  }
  ctx.putImageData(img, 0, 0);
  const band = SIZE * 0.24;
  ctx.fillStyle = colour;
  ctx.fillRect(0, SIZE - band, SIZE, band);
  ctx.fillStyle = "#fff";
  ctx.font = `700 64px ${FONT}`;
  ctx.fillText("Suggestions", 40, SIZE - band / 2 + 22);
  ctx.font = `600 26px ${FONT}`;
  ctx.fillStyle = `rgb(${deep.join(",")})`;
  ctx.fillText("made for you", 40, 60);
}

const KEY = (id: Mix["id"]) => `tonearm.mixArt.${id}`;
const drawing = new Map<string, Promise<string>>();

/** The cover for `mix` as an image URL, drawn the first time it's needed. */
export function mixArt(mix: Mix): Promise<string> {
  const stamp = `${mix.period}|${mix.title}|${mix.tracks[0]?.ratingKey ?? ""}`;
  const saved = loadJson<{ stamp: string; url: string } | null>(KEY(mix.id), null);
  if (saved?.stamp === stamp) return Promise.resolve(saved.url);
  let p = drawing.get(stamp);
  if (!p) {
    p = (async () => {
      await document.fonts.load(`700 64px ${FONT}`).catch(() => undefined);
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = SIZE;
      const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
      if (mix.id === "daylist") drawDaylist(ctx, mix);
      else await drawSuggestions(ctx, mix);
      const url = canvas.toDataURL("image/jpeg", 0.86);
      try {
        localStorage.setItem(KEY(mix.id), JSON.stringify({ stamp, url }));
      } catch {
        /* drawn again next time */
      }
      return url;
    })().finally(() => drawing.delete(stamp));
    drawing.set(stamp, p);
  }
  return p;
}

/** The last cover drawn for a mix, if any, without drawing. */
export const savedArt = (id: Mix["id"]) => loadJson<{ stamp: string; url: string } | null>(KEY(id), null)?.url ?? null;
