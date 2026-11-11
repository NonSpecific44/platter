// Settings that follow you between devices on the same Plex account, carried by the LAN sync in
// remote.ts. Each setting, and each exclusion on its own, carries the time it last changed, and
// the latest change wins. So excluding one artist on the phone and another on the PC keeps both.
import { Settings, loadJson, useSettings } from "./store";

/** The rest stay per device: EQ curve and output (each device has its own speakers), looks, etc. */
const SHARED = [
  "autoplay",
  "smartShuffle",
  "exclusivePlayback",
  "crossfade",
  "crossfadeSeconds",
  "crossfadeSkipAlbums",
  "gapless",
  "replaygain",
  "replaygainPreamp",
  "lyricsFallback",
  "eqUserPresets",
] as const;

type Kind = "artists" | "albums" | "tracks";
const KINDS: Kind[] = ["artists", "albums", "tracks"];

export interface Shared {
  values: Partial<Settings>;
  /** When each shared setting last changed here. */
  at: Record<string, number>;
  /** "kind:key" → when it was last excluded or included again (name null). */
  exclusions: Record<string, { name: string | null; at: number }>;
}

const STORE = "tonearm.sharedStamps";
let stamps: Pick<Shared, "at" | "exclusions"> = loadJson(STORE, { at: {}, exclusions: {} });
let applying = false;
const listeners = new Set<() => void>();

function save(notify = true) {
  try {
    localStorage.setItem(STORE, JSON.stringify(stamps));
  } catch {
    /* private mode: syncing still works for this run */
  }
  if (notify) listeners.forEach((f) => f());
}

/** Calls `f` whenever something shared changes here. */
export const onSharedChange = (f: () => void) => listeners.add(f);

export function sharedSnapshot(): Shared {
  const s = useSettings.getState();
  const values: Partial<Settings> = {};
  for (const k of SHARED) (values as Record<string, unknown>)[k] = s[k];
  // Exclusions made before syncing existed count as old, but still count.
  const exclusions = { ...stamps.exclusions };
  for (const kind of KINDS)
    for (const [key, name] of Object.entries(s.exclusions[kind])) exclusions[`${kind}:${key}`] ??= { name, at: 0 };
  return { values, at: { ...stamps.at }, exclusions };
}

/** Changes whenever anything shared does, so devices only send it when they differ. */
export function sharedDigest() {
  const { values, at, exclusions } = sharedSnapshot();
  const text = JSON.stringify([values, at, Object.entries(exclusions).sort(([a], [b]) => a.localeCompare(b))]);
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (Math.imul(h, 31) + text.charCodeAt(i)) | 0;
  return `${text.length}.${h >>> 0}`;
}

/**
 * The result of combining two devices' shared settings: per setting and per exclusion, the later
 * change wins. Ties (nothing changed since before syncing existed) go to the device with the
 * larger id, so both sides settle on the same answer instead of passing it back and forth.
 */
export function combine(mine: Shared, other: Shared, otherWinsTies: boolean): Shared {
  const out: Shared = { values: { ...mine.values }, at: { ...mine.at }, exclusions: { ...mine.exclusions } };
  const wins = (theirs: number, ours: number, differ: boolean) => theirs > ours || (theirs === ours && differ && otherWinsTies);
  for (const k of SHARED) {
    if (!(k in other.values)) continue;
    const theirs = (other.values as Record<string, unknown>)[k];
    const ours = (mine.values as Record<string, unknown>)[k];
    if (wins(other.at[k] ?? 0, mine.at[k] ?? 0, JSON.stringify(theirs) !== JSON.stringify(ours))) {
      (out.values as Record<string, unknown>)[k] = theirs;
      if (other.at[k] !== undefined) out.at[k] = other.at[k];
    }
  }
  for (const [id, theirs] of Object.entries(other.exclusions ?? {})) {
    const ours = mine.exclusions[id];
    if (!ours || wins(theirs.at, ours.at, theirs.name !== ours.name)) out.exclusions[id] = theirs;
  }
  return out;
}

/** Equal regardless of key order. */
function same(a: unknown, b: unknown): boolean {
  const canon = (v: unknown): unknown =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])]))
      : v;
  return JSON.stringify(canon(a)) === JSON.stringify(canon(b));
}

/** Takes whatever another device changed more recently. */
export function mergeShared(other: Shared, otherWinsTies: boolean) {
  const mine = sharedSnapshot();
  const merged = combine(mine, other, otherWinsTies);
  const patch: Partial<Settings> = {};
  for (const k of SHARED) {
    const v = (merged.values as Record<string, unknown>)[k];
    if (!same(v, (mine.values as Record<string, unknown>)[k])) (patch as Record<string, unknown>)[k] = v;
  }
  const next = { artists: {} as Record<string, string>, albums: {} as Record<string, string>, tracks: {} as Record<string, string> };
  for (const [id, e] of Object.entries(merged.exclusions)) {
    const kind = id.slice(0, id.indexOf(":")) as Kind;
    if (KINDS.includes(kind) && e.name !== null) next[kind][id.slice(id.indexOf(":") + 1)] = e.name;
  }
  if (!same(next, useSettings.getState().exclusions)) patch.exclusions = next;
  const changed = Object.keys(patch).length > 0 || !same(merged.at, mine.at) || !same(merged.exclusions, mine.exclusions);
  stamps = { at: merged.at, exclusions: merged.exclusions };
  if (Object.keys(patch).length) {
    applying = true;
    try {
      useSettings.getState().set(patch);
    } finally {
      applying = false;
    }
  }
  // Only something new is worth telling the other devices about.
  save(changed);
}

/** Stamps changes made on this device. */
export function watchShared() {
  useSettings.subscribe((s, p) => {
    if (applying) return;
    const now = Date.now();
    let touched = false;
    for (const k of SHARED) {
      if (s[k] !== p[k]) {
        stamps.at[k] = now;
        touched = true;
      }
    }
    if (s.exclusions !== p.exclusions) {
      for (const kind of KINDS) {
        const keys = new Set([...Object.keys(s.exclusions[kind]), ...Object.keys(p.exclusions[kind])]);
        for (const key of keys) {
          const name = s.exclusions[kind][key] ?? null;
          if (name !== (p.exclusions[kind][key] ?? null)) {
            stamps.exclusions[`${kind}:${key}`] = { name, at: now };
            touched = true;
          }
        }
      }
    }
    if (touched) save();
  });
}
