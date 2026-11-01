//! Audio engine: a headless libmpv instance.
//!
//! The frontend owns the queue. mpv's own playlist only ever holds the current
//! track plus (optionally) the next one, so mpv can prefetch it and play it
//! gaplessly. When mpv moves on by itself we emit `player://file` with the new
//! path and the frontend advances its queue.

use libmpv2::{
    events::{Event, PropertyData},
    mpv_end_file_reason, Format, Mpv,
};
use serde::Serialize;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

pub struct Player {
    pub mpv: Arc<Mpv>,
}

#[derive(Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct PlayerState {
    position: f64,
    duration: f64,
    paused: bool,
    idle: bool,
    volume: f64,
    muted: bool,
    buffering: bool,
}

type MpvResult<T> = Result<T, String>;

fn err(e: libmpv2::Error) -> String {
    e.to_string()
}

impl Player {
    pub fn new(app: AppHandle) -> MpvResult<Self> {
        // libmpv refuses to start unless LC_NUMERIC is "C"; GTK sets it from the environment.
        unsafe {
            libc::setlocale(libc::LC_NUMERIC, c"C".as_ptr());
        }
        let mpv = Mpv::with_initializer(|init| {
            init.set_option("vo", "null")?;
            init.set_option("video", "no")?;
            init.set_option("audio-display", "no")?;
            init.set_option("idle", "yes")?;
            init.set_option("ytdl", "no")?;
            init.set_option("gapless-audio", "weak")?;
            init.set_option("prefetch-playlist", "yes")?;
            init.set_option("cache", "yes")?;
            init.set_option("demuxer-max-bytes", "64MiB")?;
            init.set_option("demuxer-readahead-secs", "30")?;
            init.set_option("network-timeout", "15")?;
            init.set_option("audio-client-name", "Platter")?;
            init.set_option("volume-max", "100")?;
            init.set_option("replaygain-clip", "no")?;
            Ok(())
        })
        .map_err(err)?;
        let mpv = Arc::new(mpv);
        let client = mpv.create_client(Some("platter-events")).map_err(err)?;
        std::thread::Builder::new()
            .name("mpv-events".into())
            .spawn(move || event_loop(client, app))
            .map_err(|e| e.to_string())?;
        Ok(Self { mpv })
    }

    pub fn load(&self, url: &str, next: Option<&str>, start: f64, paused: bool) -> MpvResult<()> {
        self.mpv.set_property("pause", paused).map_err(err)?;
        let opts = format!("start={start:.3}");
        self.mpv
            .command("loadfile", &[url, "replace", "-1", &opts])
            .map_err(err)?;
        if let Some(next) = next {
            self.mpv.command("loadfile", &[next, "append"]).map_err(err)?;
        }
        Ok(())
    }

    /// Replace whatever is queued after the current track.
    pub fn set_next(&self, next: Option<&str>) -> MpvResult<()> {
        self.mpv.command("playlist-clear", &[]).map_err(err)?;
        if let Some(next) = next {
            self.mpv.command("loadfile", &[next, "append"]).map_err(err)?;
        }
        Ok(())
    }

    pub fn stop(&self) -> MpvResult<()> {
        self.mpv.command("stop", &[]).map_err(err)
    }

    pub fn seek(&self, seconds: f64) -> MpvResult<()> {
        self.mpv
            .command("seek", &[&format!("{seconds:.3}"), "absolute"])
            .map_err(err)
    }

    pub fn set_prop(&self, name: &str, value: &str) -> MpvResult<()> {
        self.mpv.set_property(name, value.to_string()).map_err(err)
    }

    pub fn get_prop(&self, name: &str) -> MpvResult<String> {
        self.mpv.get_property::<String>(name).map_err(err)
    }
}

const PROPS: &[(&str, Format)] = &[
    ("time-pos", Format::Double),
    ("duration", Format::Double),
    ("pause", Format::Flag),
    ("idle-active", Format::Flag),
    ("volume", Format::Double),
    ("mute", Format::Flag),
    ("paused-for-cache", Format::Flag),
    ("path", Format::String),
];

fn event_loop(client: Mpv, app: AppHandle) {
    let _ = client.disable_deprecated_events();
    for (i, (name, format)) in PROPS.iter().enumerate() {
        let _ = client.observe_property(name, *format, i as u64);
    }

    let mut state = PlayerState::default();
    let mut last_emit = Instant::now() - Duration::from_secs(1);
    let mut dirty = false;

    loop {
        let mut urgent = false;
        match client.wait_event(0.25) {
            Some(Ok(Event::PropertyChange { name, change, .. })) => {
                dirty = true;
                urgent = name != "time-pos";
                match (name, change) {
                    ("time-pos", PropertyData::Double(v)) => state.position = v,
                    ("time-pos", _) => state.position = 0.0,
                    ("duration", PropertyData::Double(v)) => state.duration = v,
                    ("duration", _) => state.duration = 0.0,
                    ("pause", PropertyData::Flag(v)) => state.paused = v,
                    ("idle-active", PropertyData::Flag(v)) => {
                        state.idle = v;
                        if v {
                            let _ = app.emit("player://idle", ());
                        }
                    }
                    ("volume", PropertyData::Double(v)) => state.volume = v,
                    ("mute", PropertyData::Flag(v)) => state.muted = v,
                    ("paused-for-cache", PropertyData::Flag(v)) => state.buffering = v,
                    ("path", PropertyData::Str(p)) => {
                        let _ = app.emit("player://file", p.to_string());
                    }
                    _ => {}
                }
            }
            Some(Ok(Event::EndFile(reason))) => {
                if reason == mpv_end_file_reason::Error {
                    let _ = app.emit("player://error", "Playback failed for this track");
                }
            }
            Some(Ok(Event::Shutdown)) => break,
            _ => {}
        }
        if dirty && (urgent || last_emit.elapsed() >= Duration::from_millis(250)) {
            let _ = app.emit("player://state", state.clone());
            last_emit = Instant::now();
            dirty = false;
        }
    }
}
