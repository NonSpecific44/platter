import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { FolderPlus, LogOut, RefreshCw, Server as ServerIcon, Trash2, X } from "lucide-react";
import { audioDevices, player, usePlayer } from "../player";
import { EQ_BANDS, EQ_PRESETS, Settings, setExcluded, toast, useSession, useSettings, useNav } from "../store";
import { connectionKind } from "../connection";
import { addToPlaylist, prompt } from "../actions";
import { addFolder, removeFolder, scanLocal, useLocal } from "../local";
import { LidarrOptions, lidarrOptions } from "../lidarr";
import { SCHEMES } from "../theme";
import { TrackList } from "../components/common";
import { QueueList } from "../components/Panels";
import { measureFrameRate } from "../smooth";
import { deviceName } from "../remote";
import { refreshLibrary, useLibrary } from "../live";
import { isAndroid, isPhone } from "../platform";
import { getVersion } from "@tauri-apps/api/app";
import { checkForUpdates, installUpdate, useUpdates } from "../updates";

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

/** Asks Plex to look through the library's folders for new and changed music. */
function ScanRow() {
  const scanning = useLibrary((s) => s.scanning);
  return (
    <Row label="Scan library" hint={scanning ? "Plex is scanning your music folders…" : "Look for music added or changed on the server since its last scan"}>
      <button className="btn" disabled={scanning} onClick={() => void refreshLibrary(true)}>
        <RefreshCw size={15} className={scanning ? "spin" : ""} /> {scanning ? "Scanning…" : "Scan now"}
      </button>
    </Row>
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
          onChange={(e) => {
            const gains = s.eqUserPresets[e.target.value] ?? EQ_PRESETS[e.target.value];
            if (gains) s.set({ eqPreset: e.target.value, eqGains: [...gains], eqEnabled: true });
          }}
        >
          {Object.keys(EQ_PRESETS).map((p) => (
            <option key={p}>{p}</option>
          ))}
          {Object.keys(s.eqUserPresets).map((p) => (
            <option key={p}>{p}</option>
          ))}
          {s.eqPreset === "Custom" && <option>Custom</option>}
        </select>
        {s.eqPreset === "Custom" && (
          <button
            className="btn ghost"
            onClick={async () => {
              const name = await prompt("Name this preset");
              if (name) s.set({ eqUserPresets: { ...s.eqUserPresets, [name]: [...s.eqGains] }, eqPreset: name });
            }}
          >
            Save preset
          </button>
        )}
        {s.eqUserPresets[s.eqPreset] && (
          <button
            className="btn ghost"
            onClick={() => {
              const { [s.eqPreset]: _gone, ...rest } = s.eqUserPresets;
              s.set({ eqUserPresets: rest, eqPreset: "Custom" });
            }}
          >
            Delete preset
          </button>
        )}
        <button className="btn ghost" onClick={() => s.set({ eqGains: [...EQ_PRESETS.Flat], eqPreset: "Flat", eqPreamp: 0 })}>
          Reset
        </button>
      </div>
      <div className="eq-bands">
        <div className="eq-band preamp">
          <span className="eq-val">{s.eqPreamp > 0 ? "+" : ""}{s.eqPreamp}</span>
          <div className="eq-slider">
            <input type="range" min={-12} max={6} step={0.5} value={s.eqPreamp} aria-label="Pre-amp" onChange={(e) => s.set({ eqPreamp: Number(e.target.value) })} />
          </div>
          <span className="eq-freq">Pre</span>
        </div>
        {EQ_BANDS.map((f, i) => (
          <div className="eq-band" key={f}>
            <span className="eq-val">{s.eqGains[i] > 0 ? "+" : ""}{s.eqGains[i]}</span>
            <div className="eq-slider">
              <input type="range" min={-12} max={12} step={0.5} value={s.eqGains[i]} aria-label={`${f} Hz`} onChange={(e) => setGain(i, Number(e.target.value))} />
            </div>
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
      ? "Restart Platter to apply"
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

/** Picks a folder: the system dialog on desktop, a list and a path box on Android. */
export async function addMusicFolder() {
  if (!android) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({ directory: true, multiple: false, title: "Add a music folder" });
    if (typeof picked === "string") addFolder(picked);
    return;
  }
  try {
    const path = await invoke<string>("local_pick_folder");
    if (path) addFolder(path);
  } catch (e) {
    toast(String(e), { error: true });
  }
}

function LocalSettings() {
  const folders = useSettings((s) => s.localFolders);
  const { scanning, tracks } = useLocal();
  const go = useNav((s) => s.go);
  return (
    <section className="set-group">
      <h2>Music on this device</h2>
      <Row label="Folders" hint={`${tracks.length.toLocaleString()} tracks. If a song is also on Plex, it appears once and the local file plays.`}>
        <div className="row gap">
          <button className="btn" onClick={() => void addMusicFolder()}>
            <FolderPlus size={15} /> Add folder
          </button>
          <button className="btn ghost" disabled={scanning} onClick={() => void scanLocal(true)}>
            {scanning ? "Scanning…" : "Scan now"}
          </button>
          <button className="btn ghost" onClick={() => go({ kind: "local" })}>
            Open
          </button>
        </div>
      </Row>
      {folders.map((f) => (
        <Row key={f} label={f}>
          <button className="icon-btn" title="Remove from library (your files aren't touched)" onClick={() => removeFolder(f)}>
            <X size={16} />
          </button>
        </Row>
      ))}
      <Row label="Look up files with missing tags" hint="Sends the file's name to musicbrainz.org when a track has no usable tags">
        <Toggle k="localAutoMatch" />
      </Row>
    </section>
  );
}

function LidarrSettings() {
  const s = useSettings();
  const [opts, setOpts] = useState<LidarrOptions | null>(null);
  const [status, setStatus] = useState("");
  const test = async () => {
    setStatus("Connecting…");
    try {
      const o = await lidarrOptions();
      setOpts(o);
      s.set({
        lidarrRoot: s.lidarrRoot || o.roots[0]?.path || "",
        lidarrQuality: s.lidarrQuality || o.quality[0]?.id || 0,
        lidarrMetadata: s.lidarrMetadata || o.metadata[0]?.id || 0,
      });
      setStatus("Connected");
    } catch (e) {
      setOpts(null);
      setStatus(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <section className="set-group">
      <h2>Lidarr requests</h2>
      <Row label="Address" hint="For example http://192.168.1.10:8686">
        <input className="text-input" value={s.lidarrUrl} placeholder="http://…:8686" onChange={(e) => s.set({ lidarrUrl: e.target.value })} />
      </Row>
      <Row label="API key" hint="In Lidarr: Settings → General → Security">
        <input className="text-input" type="password" value={s.lidarrKey} onChange={(e) => s.set({ lidarrKey: e.target.value })} />
      </Row>
      <Row label="Connection" hint={status || undefined}>
        <div className="row gap">
          <button className="btn" disabled={!s.lidarrUrl || !s.lidarrKey} onClick={test}>
            Test
          </button>
          <button className="btn ghost" onClick={() => useNav.getState().go({ kind: "requests" })}>
            Request music
          </button>
        </div>
      </Row>
      {opts && (
        <>
          <Row label="Save new music to">
            <select value={s.lidarrRoot} onChange={(e) => s.set({ lidarrRoot: e.target.value })}>
              {opts.roots.map((r) => (
                <option key={r.path}>{r.path}</option>
              ))}
            </select>
          </Row>
          <Row label="Quality profile">
            <select value={s.lidarrQuality} onChange={(e) => s.set({ lidarrQuality: Number(e.target.value) })}>
              {opts.quality.map((q) => (
                <option key={q.id} value={q.id}>
                  {q.name}
                </option>
              ))}
            </select>
          </Row>
          <Row label="Metadata profile">
            <select value={s.lidarrMetadata} onChange={(e) => s.set({ lidarrMetadata: Number(e.target.value) })}>
              {opts.metadata.map((q) => (
                <option key={q.id} value={q.id}>
                  {q.name}
                </option>
              ))}
            </select>
          </Row>
        </>
      )}
    </section>
  );
}

function Exclusions() {
  const x = useSettings((s) => s.exclusions);
  const rows = (["artists", "albums", "tracks"] as const).flatMap((kind) => Object.entries(x[kind]).map(([key, name]) => ({ kind, key, name })));
  return (
    <>
      <Row label="Excluded from autoplay and shuffle" hint={rows.length ? "Shared with your other devices." : "Choose “Exclude from autoplay” on any track or album. You can still play them yourself. Shared with your other devices."}>
        <span className="dim small">{rows.length || "None"}</span>
      </Row>
      {rows.map((r) => (
        <Row key={r.kind + r.key} label={r.name} hint={r.kind === "artists" ? "Artist" : r.kind === "albums" ? "Album" : "Track"}>
          <button className="icon-btn" title="Allow again" onClick={() => setExcluded(r.kind, r.key, null)}>
            <X size={16} />
          </button>
        </Row>
      ))}
    </>
  );
}

function Updates() {
  const { current, latest, checking, installing, error } = useUpdates();
  const s = useSettings();
  useEffect(() => {
    if (!current) void getVersion().then((v) => useUpdates.setState({ current: v }));
  }, [current]);
  return (
    <section className="set-group">
      <h2>Updates</h2>
      <Row
        label={latest ? `Platter ${latest.version} is available` : `Platter ${current}`}
        hint={error ?? (latest ? "Downloads and installs the update, then restarts Platter" : "Checks GitHub for new releases")}
      >
        <div className="row gap">
          {latest && (
            <button className="btn primary" disabled={installing} onClick={() => void installUpdate()}>
              {installing ? "Updating…" : "Update now"}
            </button>
          )}
          <button className="btn" disabled={checking} onClick={() => void checkForUpdates(true)}>
            {checking ? "Checking…" : "Check now"}
          </button>
        </div>
      </Row>
      <Row label="Check for updates automatically">
        <Toggle k="autoUpdateCheck" />
      </Row>
      <Row
        label="GitHub token"
        hint="Only needed while the release repository is private: a fine-grained token with read-only access to Contents on that repository"
      >
        <input
          className="text-input"
          type="password"
          value={s.githubToken}
          placeholder="github_pat_…"
          onChange={(e) => s.set({ githubToken: e.target.value })}
        />
      </Row>
    </section>
  );
}

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
        <Row label="Server" hint={`${server?.name} · ${server ? connectionKind(server) : ""} · ${server?.uri}`}>
          <button className="btn" onClick={() => setSession({ server: undefined, section: undefined })}>
            <ServerIcon size={15} /> Change
          </button>
        </Row>
        <Row label="Music library" hint={section?.title}>
          <button className="btn" onClick={() => setSession({ section: undefined })}>
            Change
          </button>
        </Row>
        <ScanRow />
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
        <Row label="Volume normalisation" hint={android ? "Uses Plex's loudness analysis, or ReplayGain tags" : "Uses Plex's loudness analysis, or ReplayGain tags. Dynamic levels everything live, including files nothing has analysed."}>
          <Select k="replaygain" options={android ? [["no", "Off"], ["track", "Per track"], ["album", "Per album (recommended)"]] : [["no", "Off"], ["track", "Per track"], ["album", "Per album (recommended)"], ["dynamic", "Dynamic"]]} />
        </Row>
        <Row label="Normalisation pre-amp" hint={`${s.replaygainPreamp > 0 ? "+" : ""}${s.replaygainPreamp} dB`}>
          <input type="range" min={-15} max={15} step={1} value={s.replaygainPreamp} onChange={(e) => s.set({ replaygainPreamp: Number(e.target.value) })} />
        </Row>
          
        <Row label="Playback speed" hint="Pitch is preserved">
          <Select k="speed" options={[[0.75, "0.75×"], [0.9, "0.9×"], [1, "Normal"], [1.1, "1.1×"], [1.25, "1.25×"], [1.5, "1.5×"], [2, "2×"]]} />
        </Row>
        <Row label="Crossfade" hint="Blend each track into the next">
          <Toggle k="crossfade" />
        </Row>
        {s.crossfade && (
          <>
            <Row label="Crossfade length" hint={`${s.crossfadeSeconds} seconds`}>
              <input type="range" min={1} max={12} step={1} value={s.crossfadeSeconds} onChange={(e) => s.set({ crossfadeSeconds: Number(e.target.value) })} />
            </Row>
            <Row label="Keep albums gapless" hint="No crossfade between tracks from the same album">
              <Toggle k="crossfadeSkipAlbums" />
            </Row>
          </>
        )}
        <Row label="Autoplay" hint="When the queue ends, keep playing similar music">
          <Toggle k="autoplay" />
        </Row>
        <Row label="Play on one device at a time" hint="Starting music here pauses Platter on your other devices">
          <Toggle k="exclusivePlayback" />
        </Row>
        <Row label="Smart shuffle" hint="Avoid playing the same artist twice in a row">
          <Toggle k="smartShuffle" />
        </Row>
        <Exclusions />
        {android && (
          <Row
            label="Bit-perfect output"
            hint="Hands hi-res audio to your player or DAP untouched, at full 24-bit precision. Turns off the EQ, loudness levelling, crossfade and speed, which would change it. Keep Platter's volume at 100% and use the device's own."
          >
            <Toggle k="bitPerfect" />
          </Row>
        )}
        <Row label="Transcoding" hint="Lower bitrate for slow or metered connections">
          <div className="row gap">
            <Select k="transcode" options={[["never", "Never (original quality)"], ["remote", "Only when remote"], ["always", "Always"]]} />
            {s.transcode !== "never" && <Select k="transcodeKbps" options={[[96, "96 kbps"], [128, "128 kbps"], [192, "192 kbps"], [256, "256 kbps"], [320, "320 kbps"]]} />}
          </div>
        </Row>
      </section>

      <section className="set-group">
        <h2>
          Equalizer <Toggle k="eqEnabled" />
        </h2>
        <Equalizer />
      </section>
          

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
        <Row label="Interface size" hint={android ? `${Math.round(s.uiScale * 100)}%` : `${Math.round(s.uiScale * 100)}%  (Ctrl + / Ctrl −)`}>
          <input type="range" min={0.8} max={1.5} step={0.05} value={s.uiScale} onChange={(e) => s.set({ uiScale: Number(e.target.value) })} />
        </Row>
        <FrameRate />
        <Row label="Colour scheme" hint={s.colorScheme === "material" ? "Follows your wallpaper colours on Android 12 and newer" : undefined}>
          <Select k="colorScheme" options={Object.entries(SCHEMES).map(([k, v]) => [k, v.label] as [string, string])} />
        </Row>
        <Row label="Style" hint="Material uses rounder shapes and larger controls">
          <Select k="design" options={[["material", "Material"], ["classic", "Classic"]]} />
        </Row>
        {isPhone() && (
          <Row label="Track change animation" hint="How artwork moves when you swipe or skip">
            <Select k="trackAnimation" options={[["slide", "Slide"], ["stack", "Stack"], ["fade", "Fade"], ["none", "None"]]} />
          </Row>
        )}
        <Row label="Seek bar" hint={s.seekStyle === "waveform" ? "Needs Plex sonic analysis on the library; otherwise shows a plain bar" : undefined}>
          <Select k="seekStyle" options={[["waveform", "Waveform"], ["wavy", "Wavy (Android style)"], ["bar", "Plain bar"]]} />
        </Row>
      </section>

      <LocalSettings />
      <LidarrSettings />

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
        <Row label="Track-change notifications" hint="Only shown while Platter isn't focused">
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
      <Updates />
    </div>
  );
}
