// Ask Lidarr for music that isn't in the library yet.
import { useEffect, useState } from "react";
import { Check, Disc3, Loader2, Search, User } from "lucide-react";
import { LidarrAlbum, LidarrArtist, lidarrConfigured, lidarrImage, lookupAlbums, lookupArtists, requestAlbum, requestArtist } from "../lidarr";
import { toast, useNav } from "../store";

function Art({ url, round }: { url?: string; round?: boolean }) {
  const [failed, setFailed] = useState(false);
  const Icon = round ? User : Disc3;
  return (
    <div className={`cover lrow-art ${round ? "round" : ""}`}>
      {url && !failed ? <img src={url} alt="" loading="lazy" onError={() => setFailed(true)} /> : <Icon className="cover-fallback" />}
    </div>
  );
}

export function RequestsView() {
  const go = useNav((s) => s.go);
  const [q, setQ] = useState("");
  const [albums, setAlbums] = useState<LidarrAlbum[]>([]);
  const [artists, setArtists] = useState<LidarrArtist[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [requested, setRequested] = useState<Set<string>>(new Set());

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2 || !lidarrConfigured()) {
      setAlbums([]);
      setArtists([]);
      return;
    }
    setLoading(true);
    let live = true;
    const t = setTimeout(async () => {
      try {
        const [al, ar] = await Promise.all([lookupAlbums(term), lookupArtists(term)]);
        if (!live) return;
        setAlbums(al.slice(0, 12));
        setArtists(ar.slice(0, 6));
        setError(null);
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : String(e));
      }
      if (live) setLoading(false);
    }, 350);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q]);

  const ask = async (id: string, label: string, run: () => Promise<unknown>) => {
    try {
      await run();
      setRequested((s) => new Set(s).add(id));
      toast(`Requested ${label}`);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), { error: true });
    }
  };

  if (!lidarrConfigured()) {
    return (
      <div className="view">
        <header className="view-head">
          <h1>Requests</h1>
        </header>
        <p className="dim pad">Link Lidarr to request music that isn't in your library.</p>
        <button className="btn primary" onClick={() => go({ kind: "settings" })}>
          Open Settings
        </button>
      </div>
    );
  }

  return (
    <div className="view">
      <header className="view-head">
        <h1>Requests</h1>
      </header>
      <div className="phone-search">
        <Search size={20} />
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find an album or artist to request" />
        {loading && <Loader2 className="spin" size={18} />}
      </div>
      {error && <p className="dim pad">{error}</p>}
      {albums.length > 0 && <h2 className="phone-section-title">Albums</h2>}
      <div className="lrows">
        {albums.map((a) => {
          const done = requested.has(a.foreignAlbumId) || (!!a.id && !!a.monitored);
          return (
            <div className="lrow" key={a.foreignAlbumId}>
              <Art url={lidarrImage(a)} />
              <div className="lrow-text">
                <div className="lrow-title">{a.title}</div>
                <div className="lrow-sub">
                  {a.artist?.artistName}
                  {a.releaseDate && ` · ${a.releaseDate.slice(0, 4)}`}
                  {a.albumType && ` · ${a.albumType}`}
                </div>
              </div>
              <button className="btn small" disabled={done} onClick={() => ask(a.foreignAlbumId, a.title, () => requestAlbum(a))}>
                {done ? <Check size={15} /> : "Request"}
              </button>
            </div>
          );
        })}
      </div>
      {artists.length > 0 && <h2 className="phone-section-title">Artists</h2>}
      <div className="lrows">
        {artists.map((a) => {
          const done = requested.has(a.foreignArtistId) || !!a.id;
          return (
            <div className="lrow" key={a.foreignArtistId}>
              <Art url={lidarrImage(a)} round />
              <div className="lrow-text">
                <div className="lrow-title">{a.artistName}</div>
                <div className="lrow-sub">{done ? "In Lidarr" : "All albums"}</div>
              </div>
              <button className="btn small" disabled={done} onClick={() => ask(a.foreignArtistId, a.artistName, () => requestArtist(a))}>
                {done ? <Check size={15} /> : "Request"}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
