//! Audio engine: two headless libmpv instances ("decks").
//!
//! The frontend owns the queue. A deck's own playlist only ever holds the current track plus
//! (optionally) the next one, so mpv can prefetch it and play it gaplessly. When mpv moves on by
//! itself we emit `player://file` with the new path and the frontend advances its queue.
//!
//! The second deck exists for crossfades: the next track starts on the idle deck while volumes
//! ramp across, and the decks swap roles. Only the active deck reports to the frontend.

use libmpv2::{
    events::{Event, PropertyData},
    mpv_end_file_reason, Format, Mpv,
};
use serde::Serialize;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

pub struct Player {
    decks: [Arc<Mpv>; 2],
    shared: Arc<Shared>,
}

struct Shared {
    active: AtomicUsize,
    /// Bumped to cancel a running crossfade.
    fade: AtomicU64,
    /// The volume the user chose; deck volumes differ from it during a fade.
    volume: Mutex<f64>,
    filters: Mutex<Filters>,
}

/// Audio filters. Before mpv 0.38 there's no `volume-gain` (the AppImage bundles 0.37), so track
/// gain joins the app's own filters on each deck instead.
#[derive(Default)]
struct Filters {
    app: String,
    gain: [f64; 2],
}

impl Filters {
    fn chain(&self, deck: usize) -> String {
        let gain = self.gain[deck];
        match (self.app.is_empty(), gain == 0.0) {
            (_, true) => self.app.clone(),
            (true, false) => format!("lavfi=[volume={gain}dB]"),
            (false, false) => format!("{},lavfi=[volume={gain}dB]", self.app),
        }
    }
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

fn new_deck() -> MpvResult<Mpv> {
    Mpv::with_initializer(|init| {
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
    .map_err(err)
}

impl Player {
    pub fn new(app: AppHandle) -> MpvResult<Self> {
        // libmpv refuses to start unless LC_NUMERIC is "C"; GTK sets it from the environment.
        unsafe {
            libc::setlocale(libc::LC_NUMERIC, c"C".as_ptr());
        }
        let decks = [Arc::new(new_deck()?), Arc::new(new_deck()?)];
        let shared = Arc::new(Shared { active: AtomicUsize::new(0), fade: AtomicU64::new(0), volume: Mutex::new(100.0), filters: Mutex::default() });
        for (i, deck) in decks.iter().enumerate() {
            let client = deck.create_client(Some("platter-events")).map_err(err)?;
            let (app, shared, deck) = (app.clone(), shared.clone(), deck.clone());
            std::thread::Builder::new()
                .name(format!("mpv-events-{i}"))
                .spawn(move || event_loop(i, client, deck, shared, app))
                .map_err(|e| e.to_string())?;
        }
        Ok(Self { decks, shared })
    }

    fn active(&self) -> &Arc<Mpv> {
        &self.decks[self.shared.active.load(Ordering::Relaxed)]
    }

    fn idle_deck(&self) -> &Arc<Mpv> {
        &self.decks[1 - self.shared.active.load(Ordering::Relaxed)]
    }

    /// Stops any crossfade: the outgoing deck goes silent, the active one to full volume.
    fn cancel_fade(&self) {
        self.shared.fade.fetch_add(1, Ordering::Relaxed);
        let _ = self.idle_deck().command("stop", &[]);
        let v = *self.shared.volume.lock().unwrap();
        let _ = self.active().set_property("volume", v);
    }

    pub fn load(&self, url: &str, next: Option<&str>, start: f64, paused: bool) -> MpvResult<()> {
        self.cancel_fade();
        let mpv = self.active();
        mpv.set_property("pause", paused).map_err(err)?;
        let opts = format!("start={start:.3}");
        // mpv 0.38 added a playlist index before the options; the AppImage bundles 0.37.
        mpv.command("loadfile", &[url, "replace", "-1", &opts])
            .or_else(|_| mpv.command("loadfile", &[url, "replace", &opts]))
            .map_err(err)?;
        if let Some(next) = next {
            mpv.command("loadfile", &[next, "append"]).map_err(err)?;
        }
        Ok(())
    }

    /// Replace whatever is queued after the current track.
    pub fn set_next(&self, next: Option<&str>) -> MpvResult<()> {
        let mpv = self.active();
        mpv.command("playlist-clear", &[]).map_err(err)?;
        if let Some(next) = next {
            mpv.command("loadfile", &[next, "append"]).map_err(err)?;
        }
        Ok(())
    }

    /// Starts `url` on the idle deck and blends into it over `seconds`.
    pub fn crossfade(&self, url: &str, next: Option<&str>, seconds: f64) -> MpvResult<()> {
        let gen = self.shared.fade.fetch_add(1, Ordering::Relaxed) + 1;
        let old_index = self.shared.active.load(Ordering::Relaxed);
        let (old, new) = (self.decks[old_index].clone(), self.decks[1 - old_index].clone());
        // The outgoing track must not advance by itself while it fades.
        let _ = old.command("playlist-clear", &[]);
        new.set_property("volume", 0.0).map_err(err)?;
        new.set_property("pause", false).map_err(err)?;
        // From here on the new deck is what the frontend hears about.
        self.shared.active.store(1 - old_index, Ordering::Relaxed);
        new.command("loadfile", &[url, "replace"]).map_err(err)?;
        if let Some(next) = next {
            new.command("loadfile", &[next, "append"]).map_err(err)?;
        }
        let shared = self.shared.clone();
        std::thread::spawn(move || {
            let live = || shared.fade.load(Ordering::Relaxed) == gen;
            // Don't start the ramp until the new track is actually audible.
            let waited = Instant::now();
            while live() && new.get_property::<f64>("time-pos").unwrap_or(0.0) <= 0.0 && waited.elapsed() < Duration::from_secs(4) {
                std::thread::sleep(Duration::from_millis(50));
            }
            const STEP: Duration = Duration::from_millis(50);
            let total = seconds.max(0.1);
            let mut done = 0.0;
            while live() && done < total {
                std::thread::sleep(STEP);
                if new.get_property::<bool>("pause").unwrap_or(false) {
                    continue;
                }
                done += STEP.as_secs_f64();
                let x = (done / total).min(1.0);
                let v = *shared.volume.lock().unwrap();
                let _ = old.set_property("volume", v * (1.0 - x));
                let _ = new.set_property("volume", v * x);
            }
            if live() {
                let _ = old.command("stop", &[]);
                let _ = new.set_property("volume", *shared.volume.lock().unwrap());
            }
        });
        Ok(())
    }

    pub fn stop(&self) -> MpvResult<()> {
        self.cancel_fade();
        self.active().command("stop", &[]).map_err(err)
    }

    pub fn seek(&self, seconds: f64) -> MpvResult<()> {
        self.active().command("seek", &[&format!("{seconds:.3}"), "absolute"]).map_err(err)
    }

    pub fn set_prop(&self, name: &str, value: &str) -> MpvResult<()> {
        match name {
            "volume" => {
                let v: f64 = value.parse().map_err(|_| "bad volume".to_string())?;
                *self.shared.volume.lock().unwrap() = v;
                self.active().set_property("volume", v).map_err(err)
            }
            // Per-track settings belong to whichever deck is playing that track.
            "loop-file" => self.active().set_property(name, value.to_string()).map_err(err),
            "volume-gain" => {
                if self.active().set_property(name, value.to_string()).is_ok() {
                    return Ok(());
                }
                let deck = self.shared.active.load(Ordering::Relaxed);
                let mut filters = self.shared.filters.lock().unwrap();
                let gain: f64 = value.parse().map_err(|_| "bad gain".to_string())?;
                if filters.gain[deck] == gain {
                    return Ok(());
                }
                filters.gain[deck] = gain;
                self.active().set_property("af", filters.chain(deck)).map_err(err)
            }
            "af" => {
                let mut filters = self.shared.filters.lock().unwrap();
                filters.app = value.to_string();
                let active = self.shared.active.load(Ordering::Relaxed);
                let _ = self.idle_deck().set_property("af", filters.chain(1 - active));
                self.active().set_property("af", filters.chain(active)).map_err(err)
            }
            _ => {
                let result = self.active().set_property(name, value.to_string()).map_err(err);
                let _ = self.idle_deck().set_property(name, value.to_string());
                result
            }
        }
    }

    pub fn get_prop(&self, name: &str) -> MpvResult<String> {
        self.active().get_property::<String>(name).map_err(err)
    }
}

// Position is polled rather than observed: time-pos changes with every audio chunk, and waking up
// for each one is wasted work when the UI extrapolates between reports anyway.
const PROPS: &[(&str, Format)] = &[
    ("duration", Format::Double),
    ("pause", Format::Flag),
    ("idle-active", Format::Flag),
    ("mute", Format::Flag),
    ("paused-for-cache", Format::Flag),
    ("path", Format::String),
];

const REPORT_EVERY: Duration = Duration::from_millis(500);

fn event_loop(index: usize, client: Mpv, deck: Arc<Mpv>, shared: Arc<Shared>, app: AppHandle) {
    let _ = client.disable_deprecated_events();
    for (i, (name, format)) in PROPS.iter().enumerate() {
        let _ = client.observe_property(name, *format, i as u64);
    }

    let mut state = PlayerState::default();
    let mut last_emit = Instant::now() - REPORT_EVERY;
    let mut last_position = -1.0;
    let is_active = || shared.active.load(Ordering::Relaxed) == index;

    loop {
        let mut urgent = false;
        let wait = REPORT_EVERY.saturating_sub(last_emit.elapsed()).as_secs_f64().max(0.01);
        match client.wait_event(wait) {
            Some(Ok(Event::PropertyChange { name, change, .. })) => {
                urgent = true;
                match (name, change) {
                    ("duration", PropertyData::Double(v)) => state.duration = v,
                    ("duration", _) => state.duration = 0.0,
                    ("pause", PropertyData::Flag(v)) => state.paused = v,
                    ("idle-active", PropertyData::Flag(v)) => {
                        state.idle = v;
                        if v && is_active() {
                            let _ = app.emit("player://idle", ());
                        }
                    }
                    ("mute", PropertyData::Flag(v)) => state.muted = v,
                    ("paused-for-cache", PropertyData::Flag(v)) => state.buffering = v,
                    ("path", PropertyData::Str(p)) => {
                        state.position = 0.0;
                        if is_active() {
                            let _ = app.emit("player://file", p.to_string());
                        }
                    }
                    _ => {}
                }
            }
            Some(Ok(Event::EndFile(reason))) => {
                if reason == mpv_end_file_reason::Error && is_active() {
                    let _ = app.emit("player://error", "Playback failed for this track");
                }
            }
            Some(Ok(Event::Shutdown)) => break,
            _ => {}
        }
        if !is_active() {
            last_emit = Instant::now();
            continue;
        }
        if !(urgent || last_emit.elapsed() >= REPORT_EVERY) {
            continue;
        }
        if !state.idle {
            state.position = deck.get_property::<f64>("time-pos").unwrap_or(state.position);
        } else {
            state.position = 0.0;
        }
        // Paused and nothing moved: no need to wake the UI.
        if urgent || state.position != last_position {
            state.volume = *shared.volume.lock().unwrap();
            last_position = state.position;
            let _ = app.emit("player://state", state.clone());
        }
        last_emit = Instant::now();
    }
}
