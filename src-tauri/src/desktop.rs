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

/// `tonearm --next` etc. forwarded from a second instance.
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
        MenuItem::with_id(app, "window", "Show / Hide Tonearm", true, None::<&str>)?,
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
        .tooltip("Tonearm")
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

pub fn run() {
    render::configure_env();
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            handle_cli(app, &args);
        }))
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppFlags::default())
        .setup(|app| {
            let handle = app.handle().clone();
            crate::remote::start(handle.clone());
            if let Some(window) = app.get_webview_window("main") {
                render::apply(&window);
            }
            let player = Player::new(handle.clone()).map_err(|e| format!("mpv: {e}"))?;
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
            player_stop,
            player_seek,
            player_set,
            player_get,
            media_track,
            media_playback,
            media_volume,
            set_close_to_tray,
            get_render_info,
            set_render_mode,
            crate::remote::remote_reply,
            crate::remote::remote_identity,
            crate::remote::remote_discover,
            crate::remote::remote_hostname,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Tonearm");
}
