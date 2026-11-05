// Colour schemes. "platter" is the app's own palette; "material" takes the system's wallpaper
// colours on Android 12+; the rest are fixed palettes.
import { invoke } from "@tauri-apps/api/core";

interface Tones {
  accent: string;
  bg: string;
  side: string;
  elev: string;
  elev2: string;
}

export interface Scheme {
  label: string;
  dark?: Tones;
  light?: Tones;
}

const fixed = (accent: string, accentLight: string, d: [string, string, string, string], l: [string, string, string, string]) => ({
  dark: { accent, bg: d[0], side: d[1], elev: d[2], elev2: d[3] },
  light: { accent: accentLight, bg: l[0], side: l[1], elev: l[2], elev2: l[3] },
});

export const SCHEMES: Record<string, Scheme> = {
  platter: { label: "Platter (default)" },
  material: { label: "Material You (from your wallpaper)" },
  ocean: { label: "Ocean", ...fixed("#4fb3ff", "#0067b8", ["#0e141a", "#0a0f14", "#17202a", "#202c38"], ["#f6fafe", "#e9f1f8", "#ffffff", "#e2ecf5"]) },
  forest: { label: "Forest", ...fixed("#5fce8c", "#1a7f4b", ["#0f1512", "#0a0f0c", "#18211c", "#212d26"], ["#f6faf7", "#e8f2eb", "#ffffff", "#e0ece4"]) },
  violet: { label: "Violet", ...fixed("#b79cff", "#6a3fd1", ["#131118", "#0d0b12", "#1e1a27", "#282333"], ["#f9f7fe", "#eeeaf9", "#ffffff", "#e8e3f6"]) },
  rose: { label: "Rose", ...fixed("#ff7fa8", "#c2185b", ["#17101a", "#100b12", "#241a26", "#2f2231"], ["#fef7f9", "#f8e9ee", "#ffffff", "#f5e0e7"]) },
  mono: { label: "Monochrome", ...fixed("#e6e6e6", "#222222", ["#101010", "#0a0a0a", "#1a1a1a", "#242424"], ["#fafafa", "#efefef", "#ffffff", "#e6e6e6"]) },
};

const TOKENS = ["--accent", "--bg", "--bg-side", "--bg-elev", "--bg-elev2"];

let dynamic: { dark: Tones; light: Tones } | null | undefined;

async function dynamicScheme() {
  if (dynamic !== undefined) return dynamic;
  try {
    const c = await invoke<Record<string, string>>("dynamic_colors");
    dynamic = c.a200
      ? {
          dark: { accent: c.a200, bg: c.n900, side: c.n900, elev: c.n800, elev2: c.n700 },
          light: { accent: c.a600, bg: c.n10, side: c.n50, elev: c.n50, elev2: c.n100 },
        }
      : null;
  } catch {
    dynamic = null;
  }
  // Material's baseline palette where wallpaper colours aren't available.
  dynamic ??= {
    dark: { accent: "#d0bcff", bg: "#141218", side: "#141218", elev: "#211f26", elev2: "#2b2930" },
    light: { accent: "#6750a4", bg: "#fef7ff", side: "#f7f2fa", elev: "#f3edf7", elev2: "#ece6f0" },
  };
  return dynamic;
}

/** Applies the scheme to the page. Returns the accent it set, if it sets one. */
export async function applyScheme(name: string, mode: "dark" | "light"): Promise<string | null> {
  const root = document.documentElement.style;
  const set = name === "material" ? await dynamicScheme() : SCHEMES[name];
  const tones = set?.[mode];
  if (!tones) {
    TOKENS.forEach((t) => root.removeProperty(t));
    return null;
  }
  root.setProperty("--bg", tones.bg);
  root.setProperty("--bg-side", tones.side);
  root.setProperty("--bg-elev", tones.elev);
  root.setProperty("--bg-elev2", tones.elev2);
  return tones.accent;
}
