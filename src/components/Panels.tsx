import { useEffect, useRef, useState } from "react";
import { GripVertical, ListPlus, Mic2, Trash2, X } from "lucide-react";
import { player, usePlayer, QItem } from "../player";
import { activeLine, getLyrics, Lyrics } from "../lyrics";
import { fmtTime, openMenu, useNav, useSettings } from "../store";
import { trackMenu, addToPlaylist } from "../actions";
import { Cover, PlayingBars } from "./common";

// ---- queue ---------------------------------------------------------------------

export function QueueRow({ item, i, current, onDragStart, onDrop }: {
  item: QItem;
  i: number;
  current?: boolean;
  onDragStart?: (i: number) => void;
  onDrop?: (i: number) => void;
}) {
  const paused = usePlayer((s) => s.paused || !s.loaded);
  const [over, setOver] = useState(false);
  const t = item.track;
  return (
    <div
      className={`qrow ${current ? "current" : ""} ${over ? "drop-over" : ""}`}
      draggable={!current}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", String(i));
        onDragStart?.(i);
      }}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        onDrop?.(i);
      }}
      onDoubleClick={() => player.jump(i)}
      onContextMenu={(e) =>
        openMenu(e, [
          ...trackMenu([t]).filter((m) => m.label !== "Play"),
          { separator: true, label: "" },
          { label: "Remove from queue", icon: <Trash2 size={15} />, danger: true, run: () => player.removeAt(i) },
        ])
      }
    >
      {!current && <GripVertical className="grip" size={14} />}
      <Cover thumb={t.thumb} size={80} className="qrow-art" />
      <div className="qrow-meta">
        <div className="qrow-title">
          {current && <PlayingBars paused={paused} />} {t.title}
        </div>
        <div className="qrow-sub">{t.artist}</div>
      </div>
      <span className="qrow-dur">{fmtTime(t.duration / 1000)}</span>
      {!current && (
        <button className="icon-btn qrow-x" title="Remove" onClick={() => player.removeAt(i)}>
          <X size={14} />
        </button>
      )}
    </div>
  );
}

export function QueueList({ limit }: { limit?: number }) {
  const queue = usePlayer((s) => s.queue);
  const index = usePlayer((s) => s.index);
  const stopAfter = usePlayer((s) => s.stopAfter);
  const dragFrom = useRef<number | null>(null);
  const upcoming = queue.slice(index + 1, limit ? index + 1 + limit : undefined);
  const remainingMs = queue.slice(index + 1).reduce((a, x) => a + x.track.duration, 0);

  if (!queue.length) return <p className="dim pad">The queue is empty. Double-click any track to start.</p>;
  return (
    <div className="queue-list">
      <div className="q-label">Now playing</div>
      {queue[index] && <QueueRow item={queue[index]} i={index} current />}
      {stopAfter && <div className="q-note">Playback stops after this track</div>}
      <div className="q-label">
        Up next
        <span className="dim">
          {queue.length - index - 1} tracks · {fmtTime(remainingMs / 1000)}
        </span>
      </div>
      {upcoming.map((item, k) => (
        <QueueRow
          key={item.uid}
          item={item}
          i={index + 1 + k}
          onDragStart={(i) => (dragFrom.current = i)}
          onDrop={(to) => {
            if (dragFrom.current !== null) player.move(dragFrom.current, to);
            dragFrom.current = null;
          }}
        />
      ))}
      {limit && queue.length - index - 1 > limit && (
        <button className="link pad" onClick={() => useNav.getState().go({ kind: "queue" })}>
          and {queue.length - index - 1 - limit} more…
        </button>
      )}
    </div>
  );
}

function QueuePanel() {
  const queue = usePlayer((s) => s.queue);
  return (
    <>
      <div className="panel-head">
        <h3>Queue</h3>
        <button className="icon-btn" title="Save queue as playlist" onClick={() => addToPlaylist(queue.map((q) => q.track), "new")} disabled={!queue.length}>
          <ListPlus size={16} />
        </button>
        <button className="icon-btn" title="Clear upcoming" onClick={player.clearUpcoming} disabled={!queue.length}>
          <Trash2 size={16} />
        </button>
      </div>
      <div className="panel-body">
        <QueueList limit={250} />
      </div>
    </>
  );
}

// ---- lyrics ----------------------------------------------------------------------

export function LyricsView({ big }: { big?: boolean }) {
  const track = usePlayer((s) => s.queue[s.index]?.track);
  const position = usePlayer((s) => s.position);
  const [lyrics, setLyrics] = useState<Lyrics | null | undefined>(undefined);
  const box = useRef<HTMLDivElement>(null);
  const userScroll = useRef(0);

  useEffect(() => {
    setLyrics(undefined);
    if (!track) return;
    let alive = true;
    getLyrics(track).then((l) => alive && setLyrics(l));
    return () => {
      alive = false;
    };
  }, [track?.ratingKey]);

  const active = lyrics?.synced ? activeLine(lyrics.lines, position) : -1;

  useEffect(() => {
    if (active < 0 || !box.current || Date.now() - userScroll.current < 4000) return;
    const el = box.current.querySelector<HTMLElement>(`[data-i="${active}"]`);
    if (el) box.current.scrollTo({ top: el.offsetTop - box.current.clientHeight * 0.38, behavior: "smooth" });
  }, [active]);

  if (!track) return <p className="dim pad">Nothing playing.</p>;
  if (lyrics === undefined) return <p className="dim pad">Looking for lyrics…</p>;
  if (!lyrics)
    return (
      <div className="lyrics-empty">
        <Mic2 size={28} />
        <p>No lyrics found for this track.</p>
        {!useSettings.getState().lyricsFallback && <p className="dim small">Turn on LRCLIB lookups in Settings to search online.</p>}
      </div>
    );

  return (
    <div className={`lyrics ${big ? "big" : ""} ${lyrics.synced ? "synced" : ""}`} ref={box} onWheel={() => (userScroll.current = Date.now())}>
      <div className="lyrics-pad" />
      {lyrics.lines.map((l, i) => (
        <p
          key={i}
          data-i={i}
          className={`${i === active ? "active" : ""} ${i < active ? "past" : ""} ${l.text ? "" : "gap"}`}
          onClick={() => l.time !== null && player.seek(l.time)}
        >
          {l.text || "♪"}
        </p>
      ))}
      <div className="lyrics-source">Lyrics: {lyrics.source}</div>
      <div className="lyrics-pad" />
    </div>
  );
}

export function SidePanel() {
  const panel = useNav((s) => s.panel);
  if (panel === "none") return null;
  return <aside className="sidepanel">{panel === "queue" ? <QueuePanel /> : <><div className="panel-head"><h3>Lyrics</h3></div><div className="panel-body"><LyricsView /></div></>}</aside>;
}
