import { useEffect, useMemo, useRef, useState } from "react";
import { Command, Disc3, ListMusic, Music, Search, User } from "lucide-react";
import { Album, Artist, Hub, Playlist, Track } from "../plex";
import { player, usePlayer } from "../player";
import { sectionKey, server, useNav, useSettings, View } from "../store";
import { playAlbum } from "../actions";
import { Cover } from "./common";
import { toggleMini } from "../mini";

interface Entry {
  key: string;
  kind: "command" | "artist" | "album" | "track" | "playlist";
  title: string;
  sub?: string;
  thumb?: string;
  run: (alt: boolean) => void;
}

function commands(): Entry[] {
  const nav = useNav.getState();
  const go = (v: View) => () => nav.go(v);
  const s = useSettings.getState();
  const list: [string, () => void][] = [
    ["Go to Home", go({ kind: "home" })],
    ["Go to Artists", go({ kind: "artists" })],
    ["Go to Albums", go({ kind: "albums" })],
    ["Go to Playlists", go({ kind: "playlists" })],
    ["Go to Queue", go({ kind: "queue" })],
    ["Open Settings", go({ kind: "settings" })],
    ["Shuffle entire library", () => player.shuffleLibrary()],
    ["Play / Pause", () => player.toggle()],
    ["Next track", () => player.next()],
    ["Previous track", () => player.previous()],
    ["Toggle shuffle", () => player.setShuffle(!usePlayer.getState().shuffle)],
    ["Cycle repeat mode", () => player.cycleRepeat()],
    ["Stop after current track", () => player.setStopAfter(true)],
    ["Clear upcoming queue", () => player.clearUpcoming()],
    ["Sleep timer: 30 minutes", () => player.setSleep(30)],
    ["Sleep timer: 60 minutes", () => player.setSleep(60)],
    ["Sleep timer: off", () => player.setSleep(null)],
    ["Toggle mini player", () => toggleMini()],
    ["Full-screen now playing", () => nav.setNowPlaying(true)],
    ["Show lyrics", () => nav.setPanel("lyrics")],
    [`Equalizer: turn ${s.eqEnabled ? "off" : "on"}`, () => s.set({ eqEnabled: !s.eqEnabled })],
    [`Theme: switch to ${document.documentElement.dataset.theme === "dark" ? "light" : "dark"}`, () =>
      s.set({ theme: document.documentElement.dataset.theme === "dark" ? "light" : "dark" })],
    ["Keyboard shortcuts", () => nav.setHelp(true)],
  ];
  return list.map(([title, run]) => ({ key: `cmd:${title}`, kind: "command", title, run }));
}

function fromHubs(hubs: Hub[]): Entry[] {
  const go = useNav.getState().go;
  const out: Entry[] = [];
  for (const h of hubs) {
    for (const it of h.items) {
      if (h.type === "artist") {
        const a = it as Artist;
        out.push({ key: `ar:${a.ratingKey}`, kind: "artist", title: a.title, sub: "Artist", thumb: a.thumb, run: () => go({ kind: "artist", id: a.ratingKey }) });
      } else if (h.type === "album") {
        const a = it as Album;
        out.push({
          key: `al:${a.ratingKey}`,
          kind: "album",
          title: a.title,
          sub: `Album · ${a.artist}${a.year ? ` · ${a.year}` : ""}`,
          thumb: a.thumb,
          run: (alt) => (alt ? playAlbum(a.ratingKey) : go({ kind: "album", id: a.ratingKey })),
        });
      } else if (h.type === "track") {
        const t = it as Track;
        out.push({
          key: `tr:${t.ratingKey}`,
          kind: "track",
          title: t.title,
          sub: `Track · ${t.artist} · ${t.album}`,
          thumb: t.thumb,
          run: (alt) => (alt ? player.addToQueue([t]) : player.playTracks([t])),
        });
      } else if (h.type === "playlist") {
        const p = it as Playlist;
        out.push({ key: `pl:${p.ratingKey}`, kind: "playlist", title: p.title, sub: `Playlist · ${p.leafCount} tracks`, thumb: p.thumb, run: () => go({ kind: "playlist", id: p.ratingKey }) });
      }
    }
  }
  return out;
}

const ICONS = { command: Command, artist: User, album: Disc3, track: Music, playlist: ListMusic };

export function Palette() {
  const { palette, setPalette } = useNav();
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Entry[]>([]);
  const [sel, setSel] = useState(0);
  const [loading, setLoading] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (palette) {
      setQ("");
      setResults([]);
      setSel(0);
    }
  }, [palette]);

  useEffect(() => {
    if (!palette || q.trim().length < 2) {
      setResults([]);
      return;
    }
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        setResults(fromHubs(await server().search(sectionKey(), q.trim())));
      } catch {
        setResults([]);
      }
      setLoading(false);
    }, 180);
    return () => clearTimeout(t);
  }, [q, palette]);

  const entries = useMemo(() => {
    const needle = q.toLowerCase().trim();
    const cmds = commands().filter((c) => !needle || needle.split(/\s+/).every((w) => c.title.toLowerCase().includes(w)));
    return needle ? [...results, ...cmds.slice(0, 5)] : cmds;
  }, [q, results]);

  useEffect(() => setSel(0), [entries.length]);
  useEffect(() => {
    listRef.current?.querySelector(".pal-item.sel")?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  if (!palette) return null;
  const close = () => setPalette(false);
  const run = (e: Entry, alt: boolean) => {
    close();
    e.run(alt);
  };

  return (
    <div className="modal-backdrop top" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="palette">
        <div className="pal-input">
          <Search size={18} />
          <input
            autoFocus
            placeholder="Search artists, albums, tracks… or type a command"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") close();
              else if (e.key === "ArrowDown") (e.preventDefault(), setSel((s) => Math.min(entries.length - 1, s + 1)));
              else if (e.key === "ArrowUp") (e.preventDefault(), setSel((s) => Math.max(0, s - 1)));
              else if (e.key === "Enter" && entries[sel]) run(entries[sel], e.shiftKey);
            }}
          />
          {loading && <div className="spinner small" />}
        </div>
        <div className="pal-list" ref={listRef}>
          {entries.map((e, i) => {
            const Icon = ICONS[e.kind];
            return (
              <div key={e.key} className={`pal-item ${i === sel ? "sel" : ""}`} onMouseMove={() => setSel(i)} onClick={(ev) => run(e, ev.shiftKey)}>
                {e.kind === "command" ? <Icon size={16} className="pal-icon" /> : <Cover thumb={e.thumb} size={80} round={e.kind === "artist"} className="pal-art" />}
                <div className="pal-text">
                  <div>{e.title}</div>
                  {e.sub && <div className="dim small">{e.sub}</div>}
                </div>
              </div>
            );
          })}
          {q.length >= 2 && !loading && !results.length && <div className="dim pad">No library matches.</div>}
        </div>
        <div className="pal-foot dim small">
          <span><kbd>↵</kbd> open / play</span>
          <span><kbd>Shift ↵</kbd> play album · add track to queue</span>
          <span><kbd>Esc</kbd> close</span>
        </div>
      </div>
    </div>
  );
}
