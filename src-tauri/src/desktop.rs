//! Desktop: mpv playback, MPRIS, notifications, tray and window handling.

use crate::media::{emit_control, show_main, ControlEvent, Media, TrackMeta};
use crate::player::Player;
use crate::render;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, State, WindowEvent,
};

#[derive(Default)]
struct AppFlags {
    close_to_tray: AtomicBool,
}

// ---- player commands -------------------------------------------------------

#[tauri::command]
fn player_load(
    player: State<Player>,
    url: String,
    next: Option<String>,
    start: f64,
    paused: bool,
) -> Result<(), String> {
    player.load(&url, next.as_deref(), start, paused)
}

#[tauri::command]
fn player_set_next(player: State<Player>, next: Option<String>) -> Result<(), String> {
    player.set_next(next.as_deref())
}

#[tauri::command]
fn player_crossfade(player: State<Player>, url: String, next: Option<String>, seconds: f64) -> Result<(), String> {
    player.crossfade(&url, next.as_deref(), seconds)
}

#[tauri::command]
fn player_stop(player: State<Player>) -> Result<(), String> {
    player.stop()
}

#[tauri::command]
fn player_seek(player: State<Player>, seconds: f64) -> Result<(), String> {
    player.seek(seconds)
}

#[tauri::command]
fn player_set(player: State<Player>, name: String, value: String) -> Result<(), String> {
    player.set_prop(&name, &value)
}

#[tauri::command]
fn player_get(player: State<Player>, name: String) -> Result<String, String> {
    player.get_prop(&name)
}

// ---- desktop integration ---------------------------------------------------

#[tauri::command]
fn media_track(app: AppHandle, meta: TrackMeta) {
    // Artwork download can block; keep it off the IPC thread.
    std::thread::spawn(move || app.state::<Media>().update_track(meta));
}

#[tauri::command]
fn media_playback(media: State<Media>, state: String, position: f64) {
    media.update_playback(&state, position);
}

#[tauri::command]
fn media_volume(media: State<Media>, volume: f64) {
    media.update_volume(volume);
}

#[tauri::command]
fn set_close_to_tray(flags: State<AppFlags>, enabled: bool) {
    flags.close_to_tray.store(enabled, Ordering::Relaxed);
}

// ---- updates ---------------------------------------------------------------------

/// "appimage" when the running copy can update itself; "package" when it was installed by a
/// package manager and has to be updated there.
#[tauri::command]
fn update_kind() -> &'static str {
    if std::env::var_os("APPIMAGE").is_some() {
        "appimage"
    } else {
        "package"
    }
}

/// Downloads the AppImage named in the release's `latest.json`, checks its signature against the
/// public key built into the app, swaps it in and restarts. GitHub asset URLs need
/// `Accept: application/octet-stream`, and a token while the repository is private.
#[tauri::command]
async fn update_install(app: AppHandle, manifest_url: String, token: Option<String>) -> Result<bool, String> {
    use tauri_plugin_updater::UpdaterExt;
    let url = manifest_url.parse().map_err(|e| format!("{e}"))?;
    let mut builder = app
        .updater_builder()
        .endpoints(vec![url])
        .map_err(|e| e.to_string())?
        .header("Accept", "application/octet-stream")
        .map_err(|e| e.to_string())?;
    if let Some(t) = token.filter(|t| !t.trim().is_empty()) {
        builder = builder.header("Authorization", format!("Bearer {}", t.trim())).map_err(|e| e.to_string())?;
    }
    let updater = builder.build().map_err(|e| e.to_string())?;
    let Some(update) = updater.check().await.map_err(|e| e.to_string())? else {
        return Ok(false);
    };
    update.download_and_install(|_, _| {}, || {}).await.map_err(|e| e.to_string())?;
    relaunch(&app);
    Ok(true)
}

/// A value from the environment with any paths inside `mounts` taken out, or None if nothing's left.
fn outside_mounts(value: &str, mounts: &[&str]) -> Option<String> {
    if !mounts.iter().any(|m| value.contains(m)) {
        return Some(value.to_string());
    }
    let kept: Vec<&str> = value.split(':').filter(|p| !mounts.iter().any(|m| p.contains(m))).collect();
    (!kept.is_empty()).then(|| kept.join(":"))
}

/// Starts the AppImage again as if from the launcher. An AppImage points its environment into its
/// own mount, so a plain restart keeps the old version's libraries in use and its mount alive.
fn relaunch(app: &AppHandle) {
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};
    let Some(appimage) = std::env::var_os("APPIMAGE") else { app.restart() };
    let appdir = std::env::var("APPDIR").unwrap_or_default();
    let mut mounts = vec!["/.mount_"];
    if !appdir.is_empty() {
        mounts.push(&appdir);
    }
    let env = std::env::vars_os().filter_map(|(k, v)| {
        if ["APPDIR", "APPIMAGE", "ARGV0", "OWD"].iter().any(|n| k == *n) {
            return None;
        }
        match v.to_str() {
            Some(text) => outside_mounts(text, &mounts).map(|clean| (k, clean.into())),
            None => Some((k, v)),
        }
    });
    let env: Vec<(std::ffi::OsString, std::ffi::OsString)> = env.collect();
    // AppRun moves into its mount, and a working directory there would keep that mount alive.
    let dir = std::env::var("OWD").ok().filter(|d| outside_mounts(d, &mounts).is_some()).or_else(|| std::env::var("HOME").ok()).unwrap_or_else(|| "/".into());
    // The new copy has to wait for this one, or it would just hand over to it and quit.
    const WAIT: &str = r#"i=0; while kill -0 "$1" 2>/dev/null && [ $i -lt 100 ]; do sleep 0.1; i=$((i+1)); done; exec "$2""#;
    let mut command = Command::new("/bin/sh");
    // Runs after the fork. The AppImage runtime keeps its mount until every holder of an inherited
    // pipe has gone, which would otherwise include the new copy.
    unsafe {
        command.pre_exec(|| {
            for fd in 3..1024 {
                libc::close(fd);
            }
            Ok(())
        });
    }
    let started = command
        .args(["-c", WAIT, "sh", &std::process::id().to_string()])
        .arg(&appimage)
        .current_dir(dir)
        .env_clear()
        .envs(env)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
    if started.is_err() {
        app.restart();
    }
    app.exit(0);
}

#[cfg(test)]
mod tests {
    use super::outside_mounts;

    #[test]
    fn strips_only_appimage_paths() {
        let mounts = ["/.mount_", "/opt/extracted"];
        assert_eq!(outside_mounts("/usr/bin:/bin", &mounts).as_deref(), Some("/usr/bin:/bin"));
        assert_eq!(outside_mounts("/tmp/.mount_A/usr/bin:/usr/bin:/tmp/.mount_B/bin", &mounts).as_deref(), Some("/usr/bin"));
        assert_eq!(outside_mounts("/opt/extracted/lib", &mounts), None);
        assert_eq!(outside_mounts("wayland-1", &mounts).as_deref(), Some("wayland-1"));
    }
}

#[derive(serde::Serialize)]
struct RenderInfo {
    mode: String,
    effective: &'static str,
}

#[tauri::command]
fn get_render_info() -> RenderInfo {
    RenderInfo { mode: render::mode(), effective: render::effective() }
}

#[tauri::command]
fn set_render_mode(mode: String) -> Result<(), String> {
    render::set_mode(&mode)
}

/// `platter --next` etc. forwarded from a second instance.
fn handle_cli(app: &AppHandle, args: &[String]) {
    let mut handled = false;
    for arg in args.iter().skip(1) {
        let action = match arg.as_str() {
            "--toggle" | "--play-pause" => "toggle",
            "--play" => "play",
            "--pause" => "pause",
            "--next" => "next",
            "--previous" | "--prev" => "previous",
            "--stop" => "stop",
            _ => continue,
        };
        emit_control(app, ControlEvent::new(action));
        handled = true;
    }
    if !handled {
        show_main(app);
    }
}

fn toggle_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        if w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false) {
            let _ = w.hide();
        } else {
            show_main(app);
        }
    }
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let items = [
        MenuItem::with_id(app, "toggle", "Play / Pause", true, None::<&str>)?,
        MenuItem::with_id(app, "next", "Next", true, None::<&str>)?,
        MenuItem::with_id(app, "previous", "Previous", true, None::<&str>)?,
        MenuItem::with_id(app, "window", "Show / Hide Platter", true, None::<&str>)?,
        MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?,
    ];
    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(
        app,
        &[&items[0], &items[1], &items[2], &sep1, &items[3], &sep2, &items[4]],
    )?;

    TrayIconBuilder::with_id("main")
        .icon(app.default_window_icon().cloned().expect("bundled icon"))
        .tooltip("Platter")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "toggle" => emit_control(app, ControlEvent::new("toggle")),
            "next" => emit_control(app, ControlEvent::new("next")),
            "previous" => emit_control(app, ControlEvent::new("previous")),
            "window" => toggle_window(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_window(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

/// Launching from a menu hides stderr, so failures also go to a file people can find.
fn log_startup_failure(message: &str) {
    if let Some(home) = std::env::var_os("HOME") {
        let dir = std::path::PathBuf::from(home).join(".cache/platter");
        let _ = std::fs::create_dir_all(&dir);
        let _ = std::fs::write(dir.join("startup-error.log"), format!("{message}\n"));
    }
    eprintln!("{message}");
}

pub fn run() {
    std::panic::set_hook(Box::new(|info| log_startup_failure(&info.to_string())));
    render::configure_env();
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            handle_cli(app, &args);
        }))
        // Only the size is remembered; placement.rs keeps it on the main screen and not maximized.
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(tauri_plugin_window_state::StateFlags::SIZE)
                .build(),
        )
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppFlags::default())
        .setup(|app| {
            let handle = app.handle().clone();
            crate::remote::start(handle.clone());
            if let Some(window) = app.get_webview_window("main") {
                render::apply(&window);
                crate::placement::place(&window);
                // Only now the app itself, once rendering is set up (the window starts blank).
                let url = if tauri::is_dev() { app.config().build.dev_url.clone() } else { None };
                let url = url.unwrap_or_else(|| "tauri://localhost".parse().expect("app url"));
                if let Err(e) = window.navigate(url) {
                    log_startup_failure(&format!("Couldn't open the app page: {e}"));
                }
            }
            let player = Player::new(handle.clone()).map_err(|e| {
                let message = format!("Couldn't start the audio engine (mpv): {e}");
                log_startup_failure(&message);
                message
            })?;
            app.manage(player);
            app.manage(Media::new(&handle));
            if let Err(e) = build_tray(&handle) {
                eprintln!("tray unavailable: {e}");
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let flags = window.state::<AppFlags>();
                if flags.close_to_tray.load(Ordering::Relaxed) {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            player_load,
            player_set_next,
            player_crossfade,
            player_stop,
            player_seek,
            player_set,
            player_get,
            media_track,
            media_playback,
            media_volume,
            set_close_to_tray,
            get_render_info,
            update_kind,
            update_install,
            set_render_mode,
            crate::library::local_scan,
            crate::library::local_write_tags,
            crate::library::local_set_cover,
            crate::library::local_index_load,
            crate::library::local_index_save,
            crate::library::downloads_dir,
            crate::library::download_track,
            crate::library::download_delete,
            crate::remote::remote_reply,
            crate::remote::remote_identity,
            crate::remote::remote_discover,
            crate::remote::remote_hostname,
            crate::remote::remote_lan_address,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Platter");
}
