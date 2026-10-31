// Pull a vivid accent colour out of album artwork.
import { fetch } from "@tauri-apps/plugin-http";

const cache = new Map<string, string | null>();

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}

function hslToHex(h: number, s: number, l: number) {
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(c * 255)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

export async function accentFrom(url: string | undefined): Promise<string | null> {
  if (!url) return null;
  if (cache.has(url)) return cache.get(url)!;
  try {
    const r = await fetch(url);
    const bmp = await createImageBitmap(await r.blob());
    const size = 40;
    const canvas = new OffscreenCanvas(size, size);
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(bmp, 0, 0, size, size);
    const data = ctx.getImageData(0, 0, size, size).data;
    // Score 12 hue buckets by saturation × mid-lightness, then average the winner.
    const buckets = Array.from({ length: 12 }, () => ({ score: 0, h: 0, s: 0, n: 0 }));
    for (let i = 0; i < data.length; i += 4) {
      const [h, s, l] = rgbToHsl(data[i], data[i + 1], data[i + 2]);
      if (s < 0.2 || l < 0.12 || l > 0.9) continue;
      const b = buckets[Math.floor(h / 30) % 12];
      const w = s * (1 - Math.abs(l - 0.55) * 1.6);
      b.score += w;
      b.h += h * w;
      b.s += s * w;
      b.n += w;
    }
    const best = buckets.reduce((a, b) => (b.score > a.score ? b : a));
    const color = best.n > 3 ? hslToHex(best.h / best.n, Math.min(0.85, Math.max(0.5, best.s / best.n)), 0.6) : null;
    cache.set(url, color);
    return color;
  } catch {
    cache.set(url, null);
    return null;
  }
}
