// "Connect"-style device picker and the "Listening on …" bar.
import { useEffect, useState } from "react";
import { create } from "zustand";
import { Laptop, MonitorSpeaker, Pause, Play, Smartphone, Speaker, X } from "lucide-react";
import { usePlayer } from "../player";
import { fmtTime } from "../store";
import { isOurs } from "../plex";
import { Peer, control, deviceName, disconnect, discover, isAndroid, nowPlaying, playHere, playThere, sendCommand, useOutput, useRemote } from "../remote";
import { Cover } from "./common";

export const useDevicesSheet = create<{ open: boolean; set: (open: boolean) => void }>((set) => ({ open: false, set: (open) => set({ open }) }));

/** Re-render every `ms` so extrapolated positions keep moving. */
function useTick(ms: number) {
  const [, setN] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setN((n) => n + 1), ms);
    return () => clearInterval(t);
  }, [ms]);
}

function DeviceIcon({ p, size = 20 }: { p?: Peer; size?: number }) {
  const cls = p?.device.deviceClass;
  const Icon = cls === "phone" ? Smartphone : cls === "pc" ? Laptop : p ? Speaker : isAndroid() ? Smartphone : Laptop;
  return <Icon size={size} />;
}

function Progress({ position, duration }: { position: number; duration: number }) {
  return (
    <div className="dev-progress">
      <div style={{ width: `${duration ? Math.min(100, (position / duration) * 100) : 0}%` }} />
    </div>
  );
}

export function DevicesButton() {
  const target = useRemote((s) => s.target);
  const open = useDevicesSheet((s) => s.set);
  return (
    <button className={`icon-btn toggle ${target ? "on" : ""}`} onClick={() => open(true)} title={target ? `Playing on ${target.name}` : "Devices"}>
      <MonitorSpeaker size={17} />
    </button>
  );
}

export function DevicesSheet() {
  const open = useDevicesSheet((s) => s.open);
  const setOpen = useDevicesSheet((s) => s.set);
  const peers = useRemote((s) => s.peers);
  const target = useRemote((s) => s.target);
  const scanning = useRemote((s) => s.scanning);
  const hereLoaded = usePlayer((s) => s.loaded && s.queue.length > 0);
  const output = useOutput((s) => s.name);
  useTick(open ? 500 : 60_000);
  useEffect(() => {
    if (open) void discover();
  }, [open]);
  if (!open) return null;

  const list = Object.values(peers)
    .map((p) => ({ p, np: nowPlaying(p) }))
    .filter(({ p, np }) => np || isOurs(p.device.product))
    .sort((a, b) => Number(!!b.np?.playing) - Number(!!a.np?.playing));
  const close = () => setOpen(false);

  return (
    <div className="sheet-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="sheet devices">
        <div className="sheet-head">
          <h3>Devices</h3>
          <button className="icon-btn" onClick={close} title="Close">
            <X size={18} />
          </button>
        </div>

        <button
          className={`dev-row ${!target ? "current" : ""}`}
          onClick={() => {
            if (target) void disconnect(true);
            close();
          }}
        >
          <span className="dev-icon">
            <DeviceIcon />
          </span>
          <span className="dev-text">
            <span className="dev-name">This device</span>
            <span className="dev-sub">{target ? `Tap to play here instead of ${target.name}` : output ? `${deviceName()} · ${output}` : deviceName()}</span>
          </span>
        </button>

        {list.map(({ p, np }) => {
          const id = p.device.clientId;
          const isTarget = target?.clientId === id;
          const isOurDevice = isOurs(p.device.product);
          return (
            <div key={id} className={`dev-row ${isTarget ? "current" : ""}`}>
              <button
                className="dev-main"
                disabled={!isOurDevice}
                title={isOurDevice ? (hereLoaded && !target ? `Move your music to ${p.device.name}` : `Control ${p.device.name}`) : undefined}
                onClick={() => {
                  if (hereLoaded && !target) void playThere(id);
                  else void control(id);
                  close();
                }}
              >
                <span className="dev-icon">
                  <DeviceIcon p={p} />
                </span>
                <span className="dev-text">
                  <span className="dev-name">
                    {p.device.name}
                    {p.device.output && <span className="dim"> · {p.device.output}</span>}
                    {!isOurDevice && <span className="dim"> · {p.device.product}</span>}
                  </span>
                  {np ? (
                    <>
                      <span className="dev-sub">
                        {np.playing ? "▶ " : "❚❚ "}
                        {np.track.title} · {np.track.artist}
                      </span>
                      <Progress position={np.position} duration={np.duration} />
                    </>
                  ) : (
                    <span className="dev-sub">{p.reachable || p.state ? "Ready" : "Connecting…"}</span>
                  )}
                </span>
              </button>
              {np && (
                <div className="dev-actions">
                  {np.controllable && (
                    <button className="icon-btn" title={np.playing ? "Pause" : "Play"} onClick={() => sendCommand(id, np.playing ? "pause" : "play")}>
                      {np.playing ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" />}
                    </button>
                  )}
                  <button
                    className="btn small"
                    title={`Carry on here from ${fmtTime(np.position)}`}
                    onClick={() => {
                      void playHere(id);
                      close();
                    }}
                  >
                    Play here
                  </button>
                </div>
              )}
            </div>
          );
        })}

        {!list.length && (
          <p className="dim small dev-empty">
            {scanning ? "Looking for devices…" : "No other devices found. Open Platter on another device signed in to the same Plex account."}
          </p>
        )}
      </div>
    </div>
  );
}

/** Shown when nothing plays here but another device is: live progress and one-tap handoff. */
export function ElsewhereBar() {
  useTick(500);
  const peers = useRemote((s) => s.peers);
  const target = useRemote((s) => s.target);
  const playingHere = usePlayer((s) => s.loaded && !s.paused);
  const loadedHere = usePlayer((s) => s.loaded);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const openSheet = useDevicesSheet((s) => s.set);
  if (target || playingHere) return null;
  const all = Object.values(peers).map((p) => ({ p, np: nowPlaying(p) }));
  // Something playing elsewhere; or, with nothing loaded here, something paused elsewhere.
  const hit = all.find(({ np }) => np?.playing) ?? (loadedHere ? undefined : all.find(({ np }) => np));
  if (!hit || !hit.np || dismissed === hit.p.device.clientId + hit.np.track.ratingKey) return null;
  const { p, np } = hit;
  return (
    <div className="elsewhere" onClick={() => openSheet(true)}>
      <Cover thumb={np.track.thumb} className="elsewhere-art" />
      <div className="elsewhere-text">
        <div className="elsewhere-title">
          {np.track.title} <span className="dim">· {np.track.artist}</span>
        </div>
        <div className="elsewhere-where">
          <DeviceIcon p={p} size={13} /> {np.playing ? "Listening on" : "Paused on"} {p.device.name} · {fmtTime(np.position)}
        </div>
        <Progress position={np.position} duration={np.duration} />
      </div>
      <button
        className="btn small primary"
        onClick={(e) => {
          e.stopPropagation();
          void playHere(p.device.clientId);
        }}
      >
        Play here
      </button>
      <button
        className="icon-btn"
        title="Hide"
        onClick={(e) => {
          e.stopPropagation();
          setDismissed(p.device.clientId + np.track.ratingKey);
        }}
      >
        <X size={16} />
      </button>
    </div>
  );
}
