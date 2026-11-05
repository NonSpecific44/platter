import { useEffect, useRef, useState } from "react";
import {
  ListMusic, Maximize2, Mic2, MoonStar, Pause, PictureInPicture2, Play, Repeat, Repeat1, Shuffle, SkipBack,
  SkipForward, Volume1, Volume2, VolumeX, Gauge, OctagonPause, Loader2,
} from "lucide-react";
import { isAndroid, useRemote } from "../remote";
import { DevicesButton, ElsewhereBar } from "./Devices";
import { currentTrack, player, usePlayer } from "../player";
import { fmtTime, openMenu, server, useNav, useSettings, MenuItem } from "../store";
import { Cover, Heart_ } from "./common";
import { toggleMini } from "../mini";

const levelCache = new Map<string, number[] | null>();

/**
 * Seek bar: the track's loudness waveform when Plex has sonic analysis for it, a wavy line, or a
 * plain bar. Press and drag anywhere to scrub; the seek happens on release.
 */
export function SeekBar({ compact }: { compact?: boolean }) {
  const position = usePlayer((s) => s.position);
  const duration = usePlayer((s) => s.duration);
  const paused = usePlayer((s) => s.paused || !s.loaded);
  const track = usePlayer((s) => s.queue[s.index]?.track);
  const style = useSettings((s) => s.seekStyle);
  const showWave = style === "waveform" && !compact;
  const wavy = style === "wavy" && !compact;
  const [levels, setLevels] = useState<number[] | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [drag, setDrag_] = useState<number | null>(null);
  const dragRef = useRef<number | null>(null);
  const setDrag = (v: number | null) => {
    dragRef.current = v;
    setDrag_(v);
    repaint();
  };
  const ref = useRef<HTMLDivElement>(null);
  const fillRef = useRef<HTMLDivElement>(null);
  const knobRef = useRef<HTMLDivElement>(null);
  const playedRef = useRef<HTMLDivElement>(null);

  const repaint = usePlayhead((seconds) => {
    const d = usePlayer.getState().duration;
    const f = dragRef.current ?? (d ? Math.min(1, seconds / d) : 0);
    const clip = `inset(0 ${(1 - f) * 100}% 0 0)`;
    if (fillRef.current) fillRef.current.style.clipPath = clip;
    if (knobRef.current) knobRef.current.style.transform = `translateX(${f * 100}%)`;
    if (playedRef.current) playedRef.current.style.clipPath = clip;
  }, ref);
  useEffect(() => repaint(), [levels, duration, style]);

  useEffect(() => {
    setLevels(null);
    if (!track || !showWave) return;
    const key = track.ratingKey;
    if (levelCache.has(key)) return setLevels(levelCache.get(key)!);
    let alive = true;
    (async () => {
      try {
        const streams = await server().trackStreams(key);
        const audio = streams.find((s) => s.streamType === 2);
        const raw = audio ? await server().levels(audio.id, 140) : [];
        const lv = raw.length > 10 ? normalise(raw) : null;
        levelCache.set(key, lv);
        if (alive) setLevels(lv);
      } catch {
        levelCache.set(key, null);
      }
    })();
    return () => {
      alive = false;
    };
  }, [track?.ratingKey, showWave]);

  const frac = (clientX: number) => {
    const r = ref.current!.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - r.left) / r.width));
  };

  return (
    <div className={`seek ${levels ? "wave" : ""} ${wavy ? "wavy" : ""} ${compact ? "compact" : ""} ${drag !== null ? "scrubbing" : ""}`}>
      <span className="time">{fmtTime(drag !== null ? drag * duration : position)}</span>
      <div
        className="seek-track"
        ref={ref}
        onPointerMove={(e) => {
          if (dragRef.current !== null) setDrag(frac(e.clientX));
          else if (e.pointerType === "mouse") setHover(frac(e.clientX));
        }}
        onPointerLeave={() => setHover(null)}
        onPointerDown={(e) => {
          if (!duration) return;
          e.stopPropagation();
          e.currentTarget.setPointerCapture(e.pointerId);
          setHover(null);
          setDrag(frac(e.clientX));
        }}
        onPointerUp={(e) => {
          if (dragRef.current === null) return;
          void player.seek(frac(e.clientX) * duration);
          setDrag(null);
        }}
        onPointerCancel={() => setDrag(null)}
      >
        {levels ? (
          <div className="wave-wrap">
            {[false, true].map((played) => (
              <div key={String(played)} className={`wave-bars ${played ? "played" : ""}`} ref={played ? playedRef : undefined}>
                {levels.map((v, i) => (
                  <i key={i} style={{ height: `${Math.max(8, v * 100)}%` }} />
                ))}
              </div>
            ))}
          </div>
        ) : wavy ? (
          <div className="bar wavy-bar">
            <div className={`wavy-line ${paused ? "still" : ""}`} ref={fillRef} />
            <div className="bar-knob-track" ref={knobRef}>
              <div className="bar-knob" />
            </div>
          </div>
        ) : (
          <div className="bar">
            <div className="bar-fill" ref={fillRef} />
            <div className="bar-knob-track" ref={knobRef}>
              <div className="bar-knob" />
            </div>
          </div>
        )}
        {drag !== null && duration > 0 && (
          <div className="seek-tip" style={{ left: `${drag * 100}%` }}>
            {fmtTime(drag * duration)}
          </div>
        )}
        {drag === null && hover !== null && duration > 0 && (
          <div className="seek-tip" style={{ left: `${hover * 100}%` }}>
            {fmtTime(hover * duration)}
          </div>
        )}
      </div>
      <span className="time">{fmtTime(duration)}</span>
    </div>
  );
}

/**
 * Calls `paint` with the playhead position, extrapolated between the backend's reports. It only
 * repaints as often as the bar visibly moves (a 4-minute track on a 600 px bar moves one pixel
 * every 0.4 s), not on every display frame: repainting 175 times a second while music plays is
 * what used to cost so much CPU.
 */
export function usePlayhead(paint: (seconds: number) => void, bar?: React.RefObject<HTMLElement | null>) {
  const paintRef = useRef(paint);
  paintRef.current = paint;
  const dirty = useRef(true);
  useEffect(() => {
    let anchor = { pos: usePlayer.getState().position, at: performance.now() };
    let shown = -1;
    let timer = 0;
    const unsub = usePlayer.subscribe((s, p) => {
      if (s.position !== p.position || s.paused !== p.paused) anchor = { pos: s.position, at: performance.now() };
    });
    const tick = () => {
      const s = usePlayer.getState();
      const running = s.loaded && !s.paused && !s.buffering;
      let est = anchor.pos;
      // Cap the extrapolation so a stalled stream doesn't run away from the real position.
      if (running) est += (Math.min(performance.now() - anchor.at, 1200) / 1000) * useSettings.getState().speed;
      if (s.duration) est = Math.min(est, s.duration);
      // Reports jitter by a few ms; don't let that tug the bar backwards.
      if (running && est < shown && shown - est < 0.25) est = shown;
      if (dirty.current || (est !== shown && !document.hidden)) {
        dirty.current = false;
        shown = est;
        paintRef.current(est);
      }
      const width = bar?.current?.clientWidth || 400;
      const perPixel = s.duration ? (s.duration * 1000) / width : 500;
      timer = window.setTimeout(tick, dirty.current ? 16 : !running || document.hidden ? 200 : Math.max(33, Math.min(500, perPixel / 2)));
    };
    tick();
    return () => {
      clearTimeout(timer);
      unsub();
    };
  }, []);
  /** Repaint soon even if the playhead hasn't moved. */
  return () => {
    dirty.current = true;
  };
}

function normalise(db: number[]) {
  const min = Math.max(-60, Math.min(...db));
  const max = Math.max(...db);
  return db.map((v) => (Math.max(min, v) - min) / (max - min || 1));
}

export function Volume() {
  const volume = usePlayer((s) => s.volume);
  const muted = usePlayer((s) => s.muted);
  const Icon = muted || volume === 0 ? VolumeX : volume < 50 ? Volume1 : Volume2;
  return (
    <div className="volume" onWheel={(e) => player.setVolume(volume + (e.deltaY < 0 ? 5 : -5))}>
      <button className="icon-btn" onClick={player.toggleMute} title={muted ? "Unmute (M)" : "Mute (M)"}>
        <Icon size={18} />
      </button>
      <input
        type="range"
        min={0}
        max={100}
        value={muted ? 0 : volume}
        onChange={(e) => player.setVolume(Number(e.target.value))}
        style={{ "--v": `${muted ? 0 : volume}%` } as React.CSSProperties}
        title={`Volume ${volume}%`}
      />
    </div>
  );
}

export function Transport({ size = 20 }: { size?: number }) {
  const paused = usePlayer((s) => s.paused || !s.loaded);
  const buffering = usePlayer((s) => s.buffering && s.loaded);
  const shuffle = usePlayer((s) => s.shuffle);
  const repeat = usePlayer((s) => s.repeat);
  return (
    <div className="transport">
      <button className={`icon-btn toggle tr-shuffle ${shuffle ? "on" : ""}`} onClick={() => player.setShuffle(!shuffle)} title="Shuffle (S)">
        <Shuffle size={size - 3} />
      </button>
      <button className="icon-btn" onClick={player.previous} title="Previous (Ctrl+←)">
        <SkipBack size={size} fill="currentColor" />
      </button>
      <button className="play-btn" onClick={player.toggle} title="Play/Pause (Space)">
        {buffering ? <Loader2 className="spin" size={size} /> : paused ? <Play size={size} fill="currentColor" /> : <Pause size={size} fill="currentColor" />}
      </button>
      <button className="icon-btn" onClick={player.next} title="Next (Ctrl+→)">
        <SkipForward size={size} fill="currentColor" />
      </button>
      <button className={`icon-btn toggle tr-repeat ${repeat !== "off" ? "on" : ""}`} onClick={player.cycleRepeat} title={`Repeat: ${repeat} (R)`}>
        {repeat === "one" ? <Repeat1 size={size - 3} /> : <Repeat size={size - 3} />}
      </button>
    </div>
  );
}

function moreMenu(): MenuItem[] {
  const { sleep, stopAfter } = usePlayer.getState();
  const speed = useSettings.getState().speed;
  const setSpeed = (v: number) => useSettings.getState().set({ speed: v });
  return [
    {
      label: sleep ? "Sleep timer (on)" : "Sleep timer",
      icon: <MoonStar size={15} />,
      submenu: [
        ...[15, 30, 45, 60, 90].map((m) => ({ label: `${m} minutes`, run: () => player.setSleep(m) })),
        { label: "End of this track", run: () => player.setSleep("end") },
        ...(sleep ? [{ separator: true, label: "" }, { label: "Turn off", run: () => player.setSleep(null) }] : []),
      ],
    },
    {
      label: stopAfter ? "✓ Stop after this track" : "Stop after this track",
      icon: <OctagonPause size={15} />,
      run: () => player.setStopAfter(!stopAfter),
    },
    {
      label: `Playback speed (${speed}×)`,
      icon: <Gauge size={15} />,
      submenu: [0.75, 0.9, 1, 1.1, 1.25, 1.5, 2].map((v) => ({ label: `${v === speed ? "✓ " : ""}${v}×`, run: () => setSpeed(v) })),
    },
  ];
}

function RemoteBadge() {
  const target = useRemote((s) => s.target);
  if (!target) return null;
  return <div className="pb-remote">Playing on {target.name}</div>;
}

export function PlayerBar() {
  const track = usePlayer((s) => s.queue[s.index]?.track);
  const sleep = usePlayer((s) => s.sleep);
  const { panel, setPanel, setNowPlaying, go } = useNav();
  return (
    <footer className="playerbar">
      <ElsewhereBar />
      <div className="pb-left">
        {track ? (
          <>
            <div className="pb-art" onClick={() => setNowPlaying(true)} title="Now playing (F)">
              <Cover thumb={track.thumb} />
              <Maximize2 className="pb-art-hint" size={18} />
            </div>
            <div className="pb-meta">
              <div className="pb-title" onClick={() => track.albumKey && go({ kind: "album", id: track.albumKey })}>
                {track.title}
              </div>
              <div className="pb-artist" onClick={() => track.artistKey && go({ kind: "artist", id: track.artistKey })}>
                {track.artist}
              </div>
              <RemoteBadge />
              {!useRemote.getState().target && <TrackTech />}
            </div>
            <Heart_ t={track} />
          </>
        ) : (
          <div className="pb-meta">
            <div className="dim small">Nothing playing</div>
            <RemoteBadge />
          </div>
        )}
      </div>
      <div className="pb-center">
        <Transport />
        <SeekBar />
      </div>
      <div className="pb-right">
        <button className={`icon-btn toggle pb-more ${sleep ? "on" : ""}`} onClick={(e) => openMenu(e, moreMenu())} title="Sleep timer, speed…">
          <MoonStar size={17} />
        </button>
        <button className={`icon-btn toggle pb-lyrics ${panel === "lyrics" ? "on" : ""}`} onClick={() => setPanel(panel === "lyrics" ? "none" : "lyrics")} title="Lyrics (L)">
          <Mic2 size={17} />
        </button>
        <button className={`icon-btn toggle ${panel === "queue" ? "on" : ""}`} onClick={() => setPanel(panel === "queue" ? "none" : "queue")} title="Queue (Q)">
          <ListMusic size={17} />
        </button>
        <DevicesButton />
        {!isAndroid() && (
          <button className="icon-btn" onClick={toggleMini} title="Mini player (Ctrl+Shift+M)">
            <PictureInPicture2 size={17} />
          </button>
        )}
        <Volume />
      </div>
    </footer>
  );
}

function TrackTech() {
  const t = currentTrack();
  if (!t?.codec) return null;
  const transcode = useSettings.getState().transcode;
  return (
    <div className="pb-tech">
      {t.codec.toUpperCase()}
      {t.bitrate ? ` · ${t.bitrate} kbps` : ""}
      {transcode === "always" ? " → MP3" : ""}
    </div>
  );
}
