// Shared actions and data helpers used across views.
import { useEffect, useRef, useState, createElement } from "react";
import { create } from "zustand";
import { Album, Playlist, Track } from "./plex";
import { player } from "./player";
import { MenuItem, isExcluded, sectionKey, server, setExcluded, toast, useNav, useSettings } from "./store";
import { Ban, Disc3, Download, Heart, HeartOff, ListEnd, ListPlus, ListStart, Pencil, Play, Plus, Shuffle, Trash2, User } from "lucide-react";
import { downloadTracks, isDownloaded, localMatch, removeDownloads } from "./local";
import { useLibrary } from "./live";

const icon = (c: any) => createElement(c, { size: 15 });

// ---- cached async data -------------------------------------------------------

const dataCache = new Map<string, unknown>();
const inflight = new Map<string, Promise<unknown>>();

export function invalidate(prefix: string) {
  for (const k of [...dataCache.keys()]) if (k.startsWith(prefix)) dataCache.delete(k);
}

/** Stale-while-revalidate fetch keyed by `key`; cached data shows instantly on revisit. */
export function useData<T>(key: string | null, fn: () => Promise<T>) {
  const generation = useLibrary((s) => s.generation);
  const [data, setData] = useState<T | undefined>(() => (key ? (dataCache.get(key) as T) : undefined));
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  useEffect(() => {
    if (!key) return;
    let alive = true;
    setData(dataCache.get(key) as T);
    setError(null);
    let p = inflight.get(key) as Promise<T> | undefined;
    if (!p) {
      p = fnRef.current();
      inflight.set(key, p);
      p.finally(() => inflight.delete(key));
    }
    p.then(
      (d) => {
        dataCache.set(key, d);
        if (alive) setData(d);
      },
      (e) => alive && setError(String(e?.message ?? e)),
    );
    return () => {
      alive = false;
    };
  }, [key, tick, generation]);
  return { data, error, loading: data === undefined && !error, reload: () => (key && dataCache.delete(key), setTick((t) => t + 1)) };
}

/** Load a whole library listing in pages, updating as each page arrives. */
export function usePaged<T>(key: string, fetchPage: (start: number, size: number) => Promise<{ items: T[]; total: number }>) {
  const [state, setState] = useState<{ items: T[]; total: number; done: boolean }>(
    () => (dataCache.get(key) as any) ?? { items: [], total: 0, done: false },
  );
  const fnRef = useRef(fetchPage);
  fnRef.current = fetchPage;
  const generation = useLibrary((s) => s.generation);
  useEffect(() => {
    let alive = true;
    const cached = dataCache.get(key) as any;
    if (cached?.done && cached.generation === generation) {
      setState(cached);
      return;
    }
    // A stale complete listing stays on screen until the fresh one has fully loaded.
    const refreshing = !!cached?.done;
    if (refreshing) setState(cached);
    else setState({ items: [], total: 0, done: false });
    (async () => {
      let items: T[] = [];
      let start = 0;
      const size = 300;
      for (;;) {
        const p = await fnRef.current(start, size).catch(() => ({ items: [] as T[], total: 0 }));
        if (!alive) return;
        items = items.concat(p.items);
        start += size;
        const done = !p.items.length || items.length >= p.total;
        const st = { items, total: p.total, done, generation };
        if (done || !refreshing) setState(st);
        if (done) {
          dataCache.set(key, st);
          return;
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [key, generation]);
  return state;
}

// ---- ratings (optimistic, shared across views) -----------------------------

export const useRatings = create<Record<string, number | null>>(() => ({}));

export function ratingOf(t: { ratingKey: string; userRating?: number }) {
  const o = useRatings.getState()[t.ratingKey];
  return o !== undefined ? o : t.userRating ?? null;
}

export async function setLoved(t: { ratingKey: string; title: string }, loved: boolean) {
  useRatings.setState({ [t.ratingKey]: loved ? 10 : null });
  if (!useSettings.getState().syncRatings) return;
  try {
    await server().rate(t.ratingKey, loved ? 10 : null);
  } catch (e) {
    toast(`Couldn't save rating: ${e}`, { error: true });
  }
}

// ---- playlists ---------------------------------------------------------------

export const usePlaylists = create<{ list: Playlist[]; refresh: () => Promise<void> }>((set) => ({
  list: [],
  refresh: async () => {
    try {
      set({ list: await server().playlists() });
    } catch {
      /* offline */
    }
  },
}));

// ---- prompt modal ------------------------------------------------------------

export const usePrompt = create<{ title: string; value: string; confirm: boolean; resolve: ((v: string | null) => void) | null }>(() => ({
  title: "",
  value: "",
  confirm: false,
  resolve: null,
}));

export function prompt(title: string, value = ""): Promise<string | null> {
  return new Promise((resolve) => usePrompt.setState({ title, value, confirm: false, resolve }));
}

export async function confirmDialog(title: string): Promise<boolean> {
  const r = await new Promise<string | null>((resolve) => usePrompt.setState({ title, value: "", confirm: true, resolve }));
  return r !== null;
}

export async function addToPlaylist(tracks: Track[], playlist: Playlist | "new") {
  const keys = tracks.map((t) => t.ratingKey);
  try {
    if (playlist === "new") {
      const name = await prompt("New playlist name", tracks.length === 1 ? tracks[0].title : "");
      if (!name) return;
      await server().createPlaylist(name, keys);
      toast(`Created playlist “${name}”`);
    } else {
      await server().addToPlaylist(playlist.ratingKey, keys);
      invalidate(`playlist:${playlist.ratingKey}`);
      toast(`Added to “${playlist.title}”`);
    }
    invalidate("playlists");
    await usePlaylists.getState().refresh();
  } catch (e) {
    toast(`Couldn't update playlist: ${e}`, { error: true });
  }
}

function playlistSubmenu(get: () => Promise<Track[]>): MenuItem[] {
  return [
    { label: "New playlist…", icon: icon(Plus), run: async () => addToPlaylist(await get(), "new") },
    ...usePlaylists
      .getState()
      .list.filter((p) => !p.smart)
      .map((p) => ({ label: p.title, run: async () => addToPlaylist(await get(), p) })),
  ];
}

/** Which file the metadata editor has open. */
export const useMetadataEditor = create<{ track: Track | null; edit: (t: Track | null) => void }>((set) => ({
  track: null,
  edit: (track) => set({ track }),
}));

// ---- menus -------------------------------------------------------------------

export function trackMenu(
  tracks: Track[],
  ctx: { playAll?: Track[]; index?: number; playlistId?: string; onRemoved?: () => void } = {},
): MenuItem[] {
  const t = tracks[0];
  const go = useNav.getState().go;
  const loved = tracks.length === 1 && ratingOf(t) === 10;
  const items: MenuItem[] = [
    {
      label: "Play",
      icon: icon(Play),
      run: () => (ctx.playAll ? player.playTracks(ctx.playAll, ctx.index ?? 0) : player.playTracks(tracks)),
    },
    { label: "Play next", icon: icon(ListStart), run: () => player.playNext(tracks) },
    { label: "Add to queue", icon: icon(ListEnd), run: () => player.addToQueue(tracks) },
    { label: "Add to playlist", icon: icon(ListPlus), submenu: playlistSubmenu(async () => tracks) },
    ...(tracks.every(isDownloaded)
      ? [{ label: "Remove download", icon: icon(Trash2), run: () => removeDownloads(tracks) }]
      : tracks.every((x) => !!localMatch(x))
        ? []
        : [{ label: "Download", icon: icon(Download), run: () => downloadTracks(tracks) }]),
    { separator: true, label: "" },
  ];
  if (tracks.length === 1) {
    items.push(
      { label: loved ? "Unlove" : "Love", icon: icon(loved ? HeartOff : Heart), run: () => setLoved(t, !loved) },
      { label: "Track radio", icon: icon(Shuffle), run: () => trackRadio(t) },
      { label: "Exclude from autoplay", icon: icon(Ban), submenu: exclusionItems(t) },
      { separator: true, label: "" },
    );
    const file = localMatch(t);
    if (file) items.push({ label: "Edit metadata", icon: icon(Pencil), run: () => useMetadataEditor.getState().edit(file) });
    if (t.albumKey) items.push({ label: "Go to album", icon: icon(Disc3), run: () => go({ kind: "album", id: t.albumKey! }) });
    if (t.artistKey) items.push({ label: "Go to artist", icon: icon(User), run: () => go({ kind: "artist", id: t.artistKey! }) });
  }
  if (ctx.playlistId) {
    items.push(
      { separator: true, label: "" },
      {
        label: "Remove from playlist",
        icon: icon(Trash2),
        danger: true,
        run: async () => {
          try {
            for (const x of tracks) if (x.playlistItemID) await server().removeFromPlaylist(ctx.playlistId!, x.playlistItemID);
            invalidate(`playlist:${ctx.playlistId}`);
            ctx.onRemoved?.();
            usePlaylists.getState().refresh();
          } catch (e) {
            toast(`Couldn't remove: ${e}`, { error: true });
          }
        },
      },
    );
  }
  return items;
}

export async function albumTracks(key: string) {
  return server().albumTracks(key);
}

export async function playAlbum(key: string, shuffle = false) {
  const tracks = await albumTracks(key);
  return player.playTracks(tracks, 0, { shuffle });
}

export async function playArtist(key: string, shuffle = true) {
  const tracks = await server().artistTracks(key);
  return player.playTracks(tracks, 0, { shuffle });
}

/** "Radio": the seed track followed by a shuffled mix from the same genres/artist. */
export async function trackRadio(t: Track) {
  try {
    const s = server();
    const tracks = t.artistKey ? await s.artistTracks(t.artistKey) : [];
    const random = await s.randomTracks(sectionKey(), 80);
    const pool = [...tracks.filter((x) => x.ratingKey !== t.ratingKey).slice(0, 40), ...random].filter((x) => !isExcluded(x));
    await player.playTracks([t, ...pool.sort(() => Math.random() - 0.5)], 0);
    toast(`Radio started from “${t.title}”`);
  } catch (e) {
    toast(`Couldn't start radio: ${e}`, { error: true });
  }
}

/** Toggles for keeping a track, its album or its artist out of auto-generated queues. */
function exclusionItems(t: Track): MenuItem[] {
  const x = useSettings.getState().exclusions;
  const row = (kind: "tracks" | "albums" | "artists", key: string | undefined, label: string, name: string): MenuItem[] =>
    key ? [{ label: `${x[kind][key] ? "✓ " : ""}${label}`, run: () => setExcluded(kind, key, x[kind][key] ? null : name) }] : [];
  return [
    ...row("tracks", t.ratingKey, "This track", `${t.title} · ${t.artist}`),
    ...row("albums", t.albumKey, "This album", `${t.album} · ${t.artist}`),
    ...row("artists", t.artistKey, "This artist", t.artist),
  ];
}

export function albumMenu(a: Album): MenuItem[] {
  const go = useNav.getState().go;
  return [
    { label: "Play", icon: icon(Play), run: () => playAlbum(a.ratingKey) },
    { label: "Shuffle", icon: icon(Shuffle), run: () => playAlbum(a.ratingKey, true) },
    { label: "Play next", icon: icon(ListStart), run: async () => player.playNext(await albumTracks(a.ratingKey)) },
    { label: "Add to queue", icon: icon(ListEnd), run: async () => player.addToQueue(await albumTracks(a.ratingKey)) },
    { label: "Add to playlist", icon: icon(ListPlus), submenu: playlistSubmenu(() => albumTracks(a.ratingKey)) },
    { label: "Download", icon: icon(Download), run: async () => downloadTracks(await albumTracks(a.ratingKey)) },
    { separator: true, label: "" },
    ...(a.artistKey ? [{ label: "Go to artist", icon: icon(User), run: () => go({ kind: "artist", id: a.artistKey! }) }] : []),
    {
      label: `${useSettings.getState().exclusions.albums[a.ratingKey] ? "✓ " : ""}Exclude from autoplay`,
      icon: icon(Ban),
      run: () => setExcluded("albums", a.ratingKey, useSettings.getState().exclusions.albums[a.ratingKey] ? null : `${a.title} · ${a.artist}`),
    },
  ];
}
