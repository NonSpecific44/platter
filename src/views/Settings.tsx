import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { LogOut, RefreshCw, Server as ServerIcon, Trash2 } from "lucide-react";
import { audioDevices, player, usePlayer } from "../player";
import { EQ_BANDS, EQ_PRESETS, Settings, useSession, useSettings, useNav } from "../store";
import { addToPlaylist } from "../actions";
import { TrackList } from "../components/common";
import { QueueList } from "../components/Panels";
import { measureFrameRate } from "../smooth";
import { deviceName } from "../remote";
import { isAndroid } from "../platform";

// ---- queue page ------------------------------------------------------------------

export function QueueView() {
  const history = usePlayer((s) => s.history);
  const queue = usePlayer((s) => s.queue);
  return (
    <div className="view">
      <header className="view-head">
        <h1>Queue</h1>
        <div className="grow" />
        <button className="btn" onClick={() => addToPlaylist(queue.map((q) => q.track), "new")} disabled={!queue.length}>
          Save as playlist
        </button>
        <button className="btn" onClick={player.clearUpcoming} disabled={!queue.length}>
          Clear upcoming
        </button>
        <button className="btn ghost" onClick={player.clearAll} disabled={!queue.length}>
          <Trash2 size={15} /> Clear all
        </button>
      </header>
      <div className="queue-page">
        <QueueList />
      </div>
      {history.length > 0 && (
        <section className="section">
          <div className="shelf-head">
            <h2>Recently played</h2>
            <button className="link" onClick={() => usePlayer.setState({ history: [] })}>
              Clear history
            </button>
          </div>
          <TrackList tracks={history.slice(0, 100)} showAlbum showArtist showCover numbered="position" />
        </section>
      )}
    </div>
  );
}

// ---- settings ---------------------------------------------------------------------

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="set-row">
      <div className="set-label">
        <div>{label}</div>
        {hint && <div className="dim small">{hint}</div>}
      </div>
      <div className="set-control">{children}</div>
    </div>
  );
}

function Toggle<K extends keyof Settings>({ k }: { k: K }) {
  const v = useSettings((s) => s[k]) as boolean;
  const set = useSettings((s) => s.set);
  return (
    <label className="switch">
      <input type="checkbox" checked={v} onChange={(e) => set({ [k]: e.target.checked } as Partial<Settings>)} />
      <span />
    </label>
  );
}

function Select<K extends keyof Settings>({ k, options }: { k: K; options: [string | number, string][] }) {
  const v = useSettings((s) => s[k]);
  const set = useSettings((s) => s.set);
  return (
    <select
      value={String(v)}
      onChange={(e) => {
        const raw = e.target.value;
        const opt = options.find(([o]) => String(o) === raw);
        set({ [k]: opt ? opt[0] : raw } as Partial<Settings>);
      }}
    >
      {options.map(([o, l]) => (
        <option key={String(o)} value={String(o)}>
          {l}
        </option>
      ))}
    </select>
  );
}

function Equalizer() {
  const s = useSettings();
  const setGain = (i: number, g: number) => {
    const gains = [...s.eqGains];
    gains[i] = g;
    s.set({ eqGains: gains, eqPreset: "Custom" });
  };
  return (
    <div className={`eq ${s.eqEnabled ? "" : "disabled"}`}>
      <div className="row gap">
        <select
          value={s.eqPreset}
          onChange={(e) => EQ_PRESETS[e.target.value] && s.set({ eqPreset: e.target.value, eqGains: [...EQ_PRESETS[e.target.value]], eqEnabled: true })}
        >
          {Object.keys(EQ_PRESETS).map((p) => (
            <option key={p}>{p}</option>
          ))}
          {s.eqPreset === "Custom" && <option>Custom</option>}
        </select>
        <button className="btn ghost" onClick={() => s.set({ eqGains: [...EQ_PRESETS.Flat], eqPreset: "Flat", eqPreamp: 0 })}>
          Reset
        </button>
      </div>
      <div className="eq-bands">
        <div className="eq-band preamp">
          <span className="eq-val">{s.eqPreamp > 0 ? "+" : ""}{s.eqPreamp}</span>
          <input type="range" min={-12} max={6} step={0.5} value={s.eqPreamp} onChange={(e) => s.set({ eqPreamp: Number(e.target.value) })} />
          <span className="eq-freq">Pre</span>
        </div>
        {EQ_BANDS.map((f, i) => (
          <div className="eq-band" key={f}>
            <span className="eq-val">{s.eqGains[i] > 0 ? "+" : ""}{s.eqGains[i]}</span>
            <input type="range" min={-12} max={12} step={0.5} value={s.eqGains[i]} onChange={(e) => setGain(i, Number(e.target.value))} />
            <span className="eq-freq">{f >= 1000 ? `${f / 1000}k` : f}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Devices() {
  const [devs, setDevs] = useState<{ name: string; description: string }[]>([]);
  const load = () => audioDevices().then(setDevs);
  useEffect(() => {
    load();
  }, []);
  const v = useSettings((s) => s.audioDevice);
  const set = useSettings((s) => s.set);
  return (
    <div className="row gap">
      <select value={v} onChange={(e) => set({ audioDevice: e.target.value })} className="wide-select">
        {!devs.some((d) => d.name === v) && <option value={v}>{v}</option>}
        {devs.map((d) => (
          <option key={d.name} value={d.name}>
            {d.description || d.name}
          </option>
        ))}
      </select>
      <button className="icon-btn" title="Refresh devices" onClick={load}>
        <RefreshCw size={15} />
      </button>
    </div>
  );
}

const EFFECTIVE: Record<string, string> = {
  full: "full refresh rate",
  even: "evenly paced (window too large for full rate)",
  compat: "WebKit defaults",
};

/** Stored by the backend because it has to be known before the webview starts. */
function FrameRate() {
  const [info, setInfo] = useState<{ mode: string; effective: string } | null>(null);
  const [initial, setInitial] = useState("");
  const [fps, setFps] = useState(0);
  useEffect(() => {
    measureFrameRate().then(setFps);
    invoke<{ mode: string; effective: string }>("get_render_info")
      .then((i) => {
        setInfo(i);
        setInitial(i.mode);
      })
      .catch(() => undefined);
  }, []);
  if (!info) return null;
  const hint =
    info.mode !== initial
      ? "Restart Tonearm to apply"
      : `Now ${EFFECTIVE[info.effective] ?? info.effective}${fps ? `, drawing at ${fps} fps` : ""}. Use Compatibility if you see flicker or a blank window.`;
  return (
    <Row label="Frame rate" hint={hint}>
      <select
        value={info.mode}
        onChange={(e) => {
          const mode = e.target.value;
          invoke("set_render_mode", { mode }).then(() => setInfo({ ...info, mode }));
        }}
      >
        <option value="auto">Auto (recommended)</option>
        <option value="full">Always full refresh rate</option>
        <option value="compat">Compatibility</option>
      </select>
    </Row>
  );
}

const android = isAndroid();

export function SettingsView() {
  const { user, server, section, set: setSession, signOut } = useSession();
  const s = useSettings();
  const setHelp = useNav((n) => n.setHelp);

  return (
    <div className="view settings">
      <header className="view-head">
        <h1>Settings</h1>
      </header>

      <section className="set-group">
        <h2>Account</h2>
        <Row label={user?.title ?? "Signed in"} hint={user?.username}>
          <div className="row gap">
            {user?.thumb && <img src={user.thumb} className="avatar" alt="" />}
            <button className="btn ghost" onClick={signOut}>
              <LogOut size={15} /> Sign out
            </button>
          </div>
        </Row>
        <Row label="Server" hint={`${server?.name} · ${server?.local ? "local network" : "remote"} · ${server?.uri}`}>
          <button className="btn" onClick={() => setSession({ server: undefined, section: undefined })}>
            <ServerIcon size={15} /> Change
          </button>
        </Row>
        <Row label="Music library" hint={section?.title}>
          <button className="btn" onClick={() => setSession({ section: undefined })}>
            Change
          </button>
        </Row>
      </section>

      <section className="set-group">
        <h2>Playback</h2>
{!android && (
          <>
        <Row label="Output device">
          <Devices />
        </Row>
        <Row label="Gapless playback" hint="Seamless transitions between tracks (live albums, DJ mixes)">
          <Toggle k="gapless" />
        </Row>
          </>
        )}
{!android && (
          <>
        <Row label="Volume normalisation" hint="Uses ReplayGain tags in your files">
          <Select k="replaygain" options={[["no", "Off"], ["track", "Per track"], ["album", "Per album (recommended)"]]} />
        </Row>
        <Row label="ReplayGain pre-amp" hint={`${s.replaygainPreamp > 0 ? "+" : ""}${s.replaygainPreamp} dB`}>
          <input type="range" min={-15} max={15} step={1} value={s.replaygainPreamp} onChange={(e) => s.set({ replaygainPreamp: Number(e.target.value) })} />
        </Row>
          </>
        )}
        <Row label="Playback speed" hint="Pitch is preserved">
          <Select k="speed" options={[[0.75, "0.75×"], [0.9, "0.9×"], [1, "Normal"], [1.1, "1.1×"], [1.25, "1.25×"], [1.5, "1.5×"], [2, "2×"]]} />
        </Row>
        <Row label="Smart shuffle" hint="Avoid playing the same artist twice in a row">
          <Toggle k="smartShuffle" />
        </Row>
        <Row label="Transcoding" hint="Lower bitrate for slow or metered connections">
          <div className="row gap">
            <Select k="transcode" options={[["never", "Never (original quality)"], ["remote", "Only when remote"], ["always", "Always"]]} />
            {s.transcode !== "never" && <Select k="transcodeKbps" options={[[96, "96 kbps"], [128, "128 kbps"], [192, "192 kbps"], [256, "256 kbps"], [320, "320 kbps"]]} />}
          </div>
        </Row>
      </section>

{!android && (
          <>
      <section className="set-group">
        <h2>
          Equalizer <Toggle k="eqEnabled" />
        </h2>
        <Equalizer />
      </section>
          </>
        )}

      <section className="set-group">
        <h2>Appearance</h2>
        <Row label="Theme">
          <Select k="theme" options={[["system", "Follow system"], ["dark", "Dark"], ["light", "Light"]]} />
        </Row>
        <Row label="Accent colour from album art" hint="The UI tints itself to match what's playing">
          <Toggle k="accentFromArt" />
        </Row>
        <Row label="Accent colour" hint={s.accentFromArt ? "Used when nothing is playing" : undefined}>
          <input type="color" value={s.accent} onChange={(e) => s.set({ accent: e.target.value })} />
        </Row>
        <Row label="Interface size" hint={`${Math.round(s.uiScale * 100)}%  (Ctrl + / Ctrl −)`}>
          <input type="range" min={0.8} max={1.5} step={0.05} value={s.uiScale} onChange={(e) => s.set({ uiScale: Number(e.target.value) })} />
        </Row>
        <FrameRate />
        <Row label="Waveform seek bar" hint="Needs Plex sonic analysis on the library">
          <Toggle k="showWaveform" />
        </Row>
      </section>

      <section className="set-group">
        <h2>Lyrics</h2>
        <Row label="Look up missing lyrics on LRCLIB" hint="Sends artist and track title to lrclib.net when Plex has no lyrics">
          <Toggle k="lyricsFallback" />
        </Row>
      </section>

      <section className="set-group">
        <h2>Desktop</h2>
        <Row label="Device name" hint="How this device appears when you pick where to play on your other devices">
          <input
            className="text-input"
            value={s.deviceName}
            placeholder={deviceName()}
            onChange={(e) => s.set({ deviceName: e.target.value })}
          />
        </Row>
{!android && (
          <>
        <Row label="Close to tray" hint="Keep playing in the background when the window is closed">
          <Toggle k="closeToTray" />
        </Row>
        <Row label="Track-change notifications" hint="Only shown while Tonearm isn't focused">
          <Toggle k="notifications" />
        </Row>
          </>
        )}
        <Row label="Sync loves & ratings to Plex">
          <Toggle k="syncRatings" />
        </Row>
        <Row label="Report playback to Plex" hint="Updates play counts, “Recently played” and Now Playing on your server">
          <Toggle k="reportToPlex" />
        </Row>
        <Row label="Keyboard shortcuts">
          <button className="btn" onClick={() => setHelp(true)}>
            Show
          </button>
        </Row>
      </section>
      <p className="dim small pad">Tonearm 0.1.0</p>
    </div>
  );
}
