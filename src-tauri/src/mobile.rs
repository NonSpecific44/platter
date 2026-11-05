//! Android: playback through the native PlayerPlugin (ExoPlayer + media session).
//!
//! The commands keep the desktop names and signatures so the frontend calls them the same way;
//! desktop-only ones (tray, frame rate) are accepted and ignored.

use serde_json::{json, Value};
use tauri::plugin::{Builder as PluginBuilder, PluginHandle, TauriPlugin};
use tauri::{Manager, State, Wry};

struct Native(PluginHandle<Wry>);

fn player_plugin() -> TauriPlugin<Wry> {
    PluginBuilder::new("player")
        .setup(|app, api| {
            let handle = api.register_android_plugin("io.github.tonearm.Tonearm", "PlayerPlugin")?;
            app.manage(Native(handle));
            Ok(())
        })
        .build()
}

fn call(n: &Native, method: &str, args: Value) -> Result<Value, String> {
    n.0.run_mobile_plugin::<Value>(method, args).map_err(|e| e.to_string())
}

#[tauri::command]
fn player_load(n: State<Native>, url: String, next: Option<String>, start: f64, paused: bool) -> Result<(), String> {
    call(&n, "load", json!({ "url": url, "next": next, "start": start, "paused": paused })).map(|_| ())
}

#[tauri::command]
fn player_set_next(n: State<Native>, next: Option<String>) -> Result<(), String> {
    call(&n, "setNext", json!({ "next": next })).map(|_| ())
}

#[tauri::command]
fn player_stop(n: State<Native>) -> Result<(), String> {
    call(&n, "stop", json!({})).map(|_| ())
}

#[tauri::command]
fn player_seek(n: State<Native>, seconds: f64) -> Result<(), String> {
    call(&n, "seek", json!({ "seconds": seconds })).map(|_| ())
}

#[tauri::command]
fn player_set(n: State<Native>, name: String, value: String) -> Result<(), String> {
    call(&n, "set", json!({ "name": name, "value": value })).map(|_| ())
}

#[tauri::command]
fn player_get(n: State<Native>, name: String) -> Result<String, String> {
    let v = call(&n, "get", json!({ "name": name }))?;
    Ok(v.get("value").and_then(Value::as_str).unwrap_or_default().to_string())
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct TrackMeta {
    title: String,
    artist: String,
    album: String,
    duration: f64,
    cover_url: Option<String>,
}

#[tauri::command]
fn media_track(n: State<Native>, meta: TrackMeta) -> Result<(), String> {
    call(
        &n,
        "metadata",
        json!({
            "title": meta.title,
            "artist": meta.artist,
            "album": meta.album,
            "duration": meta.duration,
            "coverUrl": meta.cover_url,
        }),
    )
    .map(|_| ())
}

/// The media session follows the player directly.
#[tauri::command]
fn media_playback(state: String, position: f64) {
    let _ = (state, position);
}

#[tauri::command]
fn media_volume(volume: f64) {
    let _ = volume;
}

#[tauri::command]
fn player_crossfade(n: State<Native>, url: String, next: Option<String>, seconds: f64) -> Result<(), String> {
    call(&n, "crossfade", json!({ "url": url, "next": next, "seconds": seconds })).map(|_| ())
}

fn value_of(v: Value) -> String {
    v.get("value").and_then(Value::as_str).unwrap_or_default().to_string()
}

#[tauri::command]
fn player_take_over(n: State<Native>) -> Result<String, String> {
    call(&n, "takeOver", json!({})).map(value_of)
}

#[tauri::command]
fn app_background(n: State<Native>) -> Result<(), String> {
    call(&n, "background", json!({})).map(|_| ())
}

#[tauri::command]
fn system_bars(n: State<Native>, color: String, dark: bool) -> Result<(), String> {
    call(&n, "systemBars", json!({ "color": color, "dark": dark })).map(|_| ())
}

#[tauri::command]
fn auto_config(n: State<Native>, json: String) -> Result<(), String> {
    call(&n, "autoConfig", json!({ "json": json })).map(|_| ())
}

#[tauri::command]
fn dynamic_colors(n: State<Native>) -> Result<Value, String> {
    call(&n, "dynamicColors", json!({}))
}

/// Opens the system folder browser. Returns the chosen folder's path, or "" if cancelled.
#[tauri::command]
async fn local_pick_folder(n: State<'_, Native>) -> Result<String, String> {
    call(&n, "pickFolder", json!({})).map(value_of)
}

#[tauri::command]
fn update_kind() -> &'static str {
    "android"
}

#[tauri::command]
async fn update_install_apk(n: State<'_, Native>, url: String, token: Option<String>) -> Result<(), String> {
    call(&n, "installUpdate", json!({ "url": url, "token": token })).map(|_| ())
}

#[tauri::command]
fn set_close_to_tray(enabled: bool) {
    let _ = enabled;
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(player_plugin())
        .setup(|app| {
            crate::remote::start(app.handle().clone());
            Ok(())
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
            player_crossfade,
            player_take_over,
            app_background,
            auto_config,
            system_bars,
            dynamic_colors,
            local_pick_folder,
            update_kind,
            update_install_apk,
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running Platter");
}
