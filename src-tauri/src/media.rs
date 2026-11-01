//! Desktop integration: MPRIS (media keys, shell widgets, playerctl, KDE Connect),
//! track-change notifications, and a small on-disk artwork cache shared by both.

use serde::{Deserialize, Serialize};
use souvlaki::{
    MediaControlEvent, MediaControls, MediaMetadata, MediaPlayback, MediaPosition, PlatformConfig,
    SeekDirection,
};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

#[derive(Clone, Serialize)]
pub struct ControlEvent {
    pub action: &'static str,
    pub value: Option<f64>,
}

impl ControlEvent {
    pub fn new(action: &'static str) -> Self {
        Self { action, value: None }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackMeta {
    pub key: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub duration: f64,
    pub cover_url: Option<String>,
    pub notify: bool,
}

pub struct Media {
    controls: Mutex<Option<MediaControls>>,
    last_notification: Mutex<Option<u32>>,
    cover_dir: PathBuf,
}

pub fn emit_control(app: &AppHandle, ev: ControlEvent) {
    let _ = app.emit("media-control", ev);
}

pub fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

impl Media {
    pub fn new(app: &AppHandle) -> Self {
        let cover_dir = app
            .path()
            .app_cache_dir()
            .unwrap_or_else(|_| std::env::temp_dir().join("platter"))
            .join("covers");
        let _ = std::fs::create_dir_all(&cover_dir);

        let controls = MediaControls::new(PlatformConfig {
            dbus_name: "platter",
            display_name: "Platter",
            hwnd: None,
        })
        .ok()
        .and_then(|mut c| {
            let handle = app.clone();
            c.attach(move |event| on_control(&handle, event)).ok()?;
            Some(c)
        });

        Self {
            controls: Mutex::new(controls),
            last_notification: Mutex::new(None),
            cover_dir,
        }
    }

    /// Download artwork (once) and return a local path to it.
    fn cached_cover(&self, key: &str, url: &str) -> Option<PathBuf> {
        let safe: String = key.chars().filter(|c| c.is_ascii_alphanumeric()).collect();
        let path = self.cover_dir.join(format!("{safe}.jpg"));
        if path.exists() {
            return Some(path);
        }
        let bytes = ureq::get(url)
            .call()
            .ok()?
            .body_mut()
            .with_config()
            .limit(10 * 1024 * 1024)
            .read_to_vec()
            .ok()?;
        std::fs::write(&path, bytes).ok()?;
        Some(path)
    }

    pub fn update_track(&self, meta: TrackMeta) {
        let cover = meta
            .cover_url
            .as_deref()
            .and_then(|url| self.cached_cover(&meta.key, url));
        let cover_uri = cover.as_ref().map(|p| format!("file://{}", p.display()));

        if let Some(c) = self.controls.lock().unwrap().as_mut() {
            let _ = c.set_metadata(MediaMetadata {
                title: Some(&meta.title),
                artist: Some(&meta.artist),
                album: Some(&meta.album),
                cover_url: cover_uri.as_deref(),
                duration: Some(Duration::from_secs_f64(meta.duration.max(0.0))),
            });
        }

        if meta.notify {
            let mut n = notify_rust::Notification::new();
            n.appname("Platter")
                .summary(&meta.title)
                .body(&format!("{} — {}", meta.artist, meta.album))
                .timeout(notify_rust::Timeout::Milliseconds(4000))
                .hint(notify_rust::Hint::Transient(true))
                .hint(notify_rust::Hint::Category("x-gnome.music".into()))
                .hint(notify_rust::Hint::DesktopEntry("platter".into()));
            match &cover {
                Some(p) => n.icon(&p.display().to_string()),
                None => n.icon("platter"),
            };
            // Replace our previous notification instead of stacking them up.
            let mut last = self.last_notification.lock().unwrap();
            if let Some(id) = *last {
                n.id(id);
            }
            if let Ok(handle) = n.show() {
                *last = Some(handle.id());
            }
        }
    }

    pub fn update_playback(&self, state: &str, position: f64) {
        let progress = Some(MediaPosition(Duration::from_secs_f64(position.max(0.0))));
        let playback = match state {
            "playing" => MediaPlayback::Playing { progress },
            "paused" => MediaPlayback::Paused { progress },
            _ => MediaPlayback::Stopped,
        };
        if let Some(c) = self.controls.lock().unwrap().as_mut() {
            let _ = c.set_playback(playback);
        }
    }

    pub fn update_volume(&self, volume: f64) {
        if let Some(c) = self.controls.lock().unwrap().as_mut() {
            let _ = c.set_volume(volume.clamp(0.0, 1.0));
        }
    }
}

fn on_control(app: &AppHandle, event: MediaControlEvent) {
    let ev = match event {
        MediaControlEvent::Play => ControlEvent::new("play"),
        MediaControlEvent::Pause => ControlEvent::new("pause"),
        MediaControlEvent::Toggle => ControlEvent::new("toggle"),
        MediaControlEvent::Next => ControlEvent::new("next"),
        MediaControlEvent::Previous => ControlEvent::new("previous"),
        MediaControlEvent::Stop => ControlEvent::new("stop"),
        MediaControlEvent::Seek(dir) => ControlEvent {
            action: "seekBy",
            value: Some(if dir == SeekDirection::Forward { 10.0 } else { -10.0 }),
        },
        MediaControlEvent::SeekBy(dir, d) => {
            let s = d.as_secs_f64();
            ControlEvent {
                action: "seekBy",
                value: Some(if dir == SeekDirection::Forward { s } else { -s }),
            }
        }
        MediaControlEvent::SetPosition(MediaPosition(d)) => ControlEvent {
            action: "seek",
            value: Some(d.as_secs_f64()),
        },
        MediaControlEvent::SetVolume(v) => ControlEvent {
            action: "volume",
            value: Some(v * 100.0),
        },
        MediaControlEvent::Raise => {
            show_main(app);
            return;
        }
        MediaControlEvent::Quit => {
            app.exit(0);
            return;
        }
        _ => return,
    };
    emit_control(app, ev);
}
