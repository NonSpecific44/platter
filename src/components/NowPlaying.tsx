import { useEffect, useState } from "react";
import { ChevronDown, ListMusic, Mic2 } from "lucide-react";
import { usePlayer } from "../player";
import { server, useNav } from "../store";
import { Cover, Heart_ } from "./common";
import { SeekBar, Transport, Volume } from "./PlayerBar";
import { LyricsView, QueueList } from "./Panels";

export function NowPlaying() {
  const { nowPlaying, setNowPlaying, go } = useNav();
  const track = usePlayer((s) => s.queue[s.index]?.track);
  const [side, setSide] = useState<"lyrics" | "queue">("lyrics");

  useEffect(() => {
    if (!nowPlaying) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setNowPlaying(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [nowPlaying, setNowPlaying]);

  if (!nowPlaying) return null;
  const bg = track ? server().imageUrl(track.thumb, 600) : undefined;
  const goTo = (v: Parameters<typeof go>[0]) => {
    setNowPlaying(false);
    go(v);
  };

  return (
    <div className="nowplaying">
      {bg && <div className="np-bg" style={{ backgroundImage: `url("${bg}")` }} />}
      <div className="np-shade" />
      <button className="icon-btn np-close" onClick={() => setNowPlaying(false)} title="Close (Esc)">
        <ChevronDown size={26} />
      </button>
      <div className="np-body">
        <div className="np-left">
          <Cover thumb={track?.thumb} className="np-art" icon="album" />
          {track && (
            <div className="np-meta">
              <div className="np-titlerow">
                <div>
                  <h1>{track.title}</h1>
                  <p>
                    <span className="link-text" onClick={() => track.artistKey && goTo({ kind: "artist", id: track.artistKey })}>
                      {track.artist}
                    </span>
                    {" — "}
                    <span className="link-text" onClick={() => track.albumKey && goTo({ kind: "album", id: track.albumKey })}>
                      {track.album}
                    </span>
                    {track.year ? ` (${track.year})` : ""}
                  </p>
                </div>
                <Heart_ t={track} />
              </div>
              <SeekBar />
              <div className="np-controls">
                <Transport size={26} />
                <Volume />
              </div>
            </div>
          )}
        </div>
        <div className="np-right">
          <div className="np-tabs">
            <button className={side === "lyrics" ? "on" : ""} onClick={() => setSide("lyrics")}>
              <Mic2 size={15} /> Lyrics
            </button>
            <button className={side === "queue" ? "on" : ""} onClick={() => setSide("queue")}>
              <ListMusic size={15} /> Up next
            </button>
          </div>
          <div className="np-side">{side === "lyrics" ? <LyricsView big /> : <QueueList limit={100} />}</div>
        </div>
      </div>
    </div>
  );
}
