// "On this device": scanned folders and downloads.
import { useMemo, useState } from "react";
import { FolderPlus, Loader2, RefreshCw, Search } from "lucide-react";
import { useLocal, scanLocal } from "../local";
import { useNav } from "../store";
import { AlbumCard, TrackList } from "../components/common";
import { addMusicFolder } from "./Settings";

type Tab = "albums" | "tracks" | "downloads";

export function LocalView({ tab = "albums" }: { tab?: Tab }) {
  const { tracks, albums, scanning, downloading } = useLocal();
  const [q, setQ] = useState("");
  const setTab = (t: Tab) => useNav.setState((s) => ({ stack: [...s.stack.slice(0, -1), { kind: "local", tab: t }] }));
  const needle = q.trim().toLowerCase();
  const shownAlbums = useMemo(() => (needle ? albums.filter((a) => `${a.title} ${a.artist}`.toLowerCase().includes(needle)) : albums), [albums, needle]);
  const shownTracks = useMemo(() => {
    const base = tab === "downloads" ? tracks.filter((t) => t.downloaded) : tracks;
    return needle ? base.filter((t) => `${t.title} ${t.artist} ${t.album}`.toLowerCase().includes(needle)) : base;
  }, [tracks, needle, tab]);

  return (
    <div className="view">
      <header className="view-head">
        <h1>On this device</h1>
        <span className="dim">{tracks.length ? `${tracks.length.toLocaleString()} tracks` : ""}</span>
        <div className="grow" />
        <div className="filter">
          <Search size={15} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter" />
        </div>
        <button className="btn" onClick={() => void addMusicFolder()}>
          <FolderPlus size={16} /> Add folder
        </button>
        <button className="btn" onClick={() => void scanLocal(true)} disabled={scanning}>
          {scanning ? <Loader2 className="spin" size={16} /> : <RefreshCw size={16} />} Scan
        </button>
      </header>
      <div className="chips phone-chips">
        {(["albums", "tracks", "downloads"] as Tab[]).map((t) => (
          <button key={t} className={`chip ${tab === t ? "on" : ""}`} onClick={() => setTab(t)}>
            {t === "albums" ? "Albums" : t === "tracks" ? "Tracks" : "Downloads"}
          </button>
        ))}
      </div>
      {downloading > 0 && <p className="dim small pad">Downloading {downloading}…</p>}
      {tab === "albums" ? (
        <div className="grid">
          {shownAlbums.map((a) => (
            <AlbumCard key={a.ratingKey} a={a} />
          ))}
        </div>
      ) : (
        <TrackList tracks={shownTracks} showAlbum showArtist showCover numbered="position" />
      )}
      {!tracks.length && !scanning && (
        <p className="dim pad">
          No music here yet. Add a folder, or choose Download from the menu on any album or track.
        </p>
      )}
      {tab === "downloads" && tracks.length > 0 && !shownTracks.length && <p className="dim pad">Nothing downloaded yet. Choose Download from the menu on any album or track.</p>}
    </div>
  );
}
