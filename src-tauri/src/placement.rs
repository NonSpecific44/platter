//! Where the main window opens: always a normal window, smaller than the main screen, on the main
//! screen.
//!
//! On Wayland an app can't choose its screen or position, so on KDE Plasma a short KWin script
//! (loaded over D-Bus) places it as it appears: centred on the first screen in KDE's screen order,
//! no bigger than 90% of that screen's free area. Elsewhere the window is sized and centred on the
//! primary monitor directly, which works on X11 and is harmlessly ignored where it can't.

use std::time::Duration;
use tauri::{Manager, PhysicalPosition, PhysicalSize, WebviewWindow};

/// Share of the main screen the window may take at most.
const MAX_SHARE: f64 = 0.9;

pub fn place(window: &WebviewWindow) {
    let _ = window.unmaximize();
    if kde_wayland() {
        let dir = window.app_handle().path().app_cache_dir().ok();
        std::thread::spawn(move || {
            if let Err(e) = kwin_place(dir) {
                eprintln!("window placement via KWin failed: {e}");
            }
        });
    } else {
        fit_primary(window);
    }
}

fn kde_wayland() -> bool {
    let wayland = std::env::var_os("WAYLAND_DISPLAY").is_some()
        && std::env::var("GDK_BACKEND").map_or(true, |b| !b.starts_with("x11"));
    let kde = std::env::var("XDG_CURRENT_DESKTOP").is_ok_and(|d| d.to_uppercase().contains("KDE"));
    wayland && kde
}

fn fit_primary(window: &WebviewWindow) {
    let Some(monitor) = window.primary_monitor().ok().flatten().or_else(|| window.current_monitor().ok().flatten()) else {
        return;
    };
    let (area, size) = (monitor.size(), window.outer_size().unwrap_or(*monitor.size()));
    let w = size.width.min((area.width as f64 * MAX_SHARE) as u32);
    let h = size.height.min((area.height as f64 * MAX_SHARE) as u32);
    if (w, h) != (size.width, size.height) {
        let _ = window.set_size(PhysicalSize::new(w, h));
    }
    let pos = monitor.position();
    let _ = window.set_position(PhysicalPosition::new(
        pos.x + (area.width as i32 - w as i32) / 2,
        pos.y + (area.height as i32 - h as i32) / 2,
    ));
}

fn kwin_script(pid: u32) -> String {
    format!(
        r#"const PID = {pid};
const SHARE = {MAX_SHARE};
function place(w) {{
  if (!w || w.pid !== PID || !w.normalWindow) return false;
  const out = workspace.screenOrder[0] || w.output;
  const area = workspace.clientArea(KWin.MaximizeArea, out, workspace.currentDesktop);
  w.setMaximize(false, false);
  const g = w.frameGeometry;
  const width = Math.round(Math.min(g.width, area.width * SHARE));
  const height = Math.round(Math.min(g.height, area.height * SHARE));
  w.frameGeometry = {{ x: Math.round(area.x + (area.width - width) / 2), y: Math.round(area.y + (area.height - height) / 2), width: width, height: height }};
  return true;
}}
let placed = false;
for (const w of workspace.windowList()) if (place(w)) placed = true;
if (!placed) workspace.windowAdded.connect((w) => {{ if (!placed) placed = place(w); }});
"#
    )
}

fn kwin_place(dir: Option<std::path::PathBuf>) -> Result<(), String> {
    use gtk::gio::{self, prelude::*};
    use gtk::glib::Variant;
    let dir = dir.ok_or("no cache folder")?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let pid = std::process::id();
    let path = dir.join("place-window.js");
    std::fs::write(&path, kwin_script(pid)).map_err(|e| e.to_string())?;
    let bus = gio::bus_get_sync(gio::BusType::Session, gio::Cancellable::NONE).map_err(|e| e.to_string())?;
    let name = format!("platter-place-{pid}");
    let call = |method: &str, args: Option<&Variant>| {
        bus.call_sync(
            Some("org.kde.KWin"),
            "/Scripting",
            "org.kde.kwin.Scripting",
            method,
            args,
            None,
            gio::DBusCallFlags::NONE,
            3000,
            gio::Cancellable::NONE,
        )
        .map_err(|e| e.to_string())
    };
    // A copy left over from a crash would block loading under the same name.
    let _ = call("unloadScript", Some(&(name.as_str(),).to_variant()));
    call("loadScript", Some(&(path.to_string_lossy().as_ref(), name.as_str()).to_variant()))?;
    call("start", None)?;
    // Long enough for the window to appear, then the script is no longer needed.
    std::thread::sleep(Duration::from_secs(20));
    let _ = call("unloadScript", Some(&(name.as_str(),).to_variant()));
    let _ = std::fs::remove_file(&path);
    Ok(())
}
