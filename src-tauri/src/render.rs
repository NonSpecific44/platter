//! Rendering at the monitor's refresh rate.
//!
//! WebKitGTK's DMA-BUF renderer caps page updates at 60 fps, which judders on high refresh rate
//! screens because 60 doesn't divide evenly into 144 or 175. Without it, WebKit follows the
//! monitor, but its "prefer ~60 fps" feature picks the divisor of the refresh rate closest to 60
//! (175 Hz → 87 fps, 144 Hz → 72 fps): evenly paced, just not the full rate.
//!
//! That path copies every frame through the CPU, so the full rate is only sustainable up to a
//! certain number of pixels per second; past that, frames drop irregularly, which looks worse
//! than an even half rate. In "auto" the choice is made at launch from window size × refresh.
//!
//! Modes (Settings → Appearance → Frame rate):
//!   auto   full rate when the machine keeps up, otherwise evenly paced
//!   full   always the monitor's full rate
//!   compat WebKit defaults (DMA-BUF renderer, 60 fps)

use std::ffi::{c_char, c_void, CStr};
use std::path::PathBuf;
use std::sync::Mutex;

const MODE_FILE: &str = "render-mode";
/// Measured on a Radeon 7900 XTX / 7800X3D: 1900×1100 at 175 Hz held every frame, 2694×1242 didn't.
const FULL_RATE_PIXELS_PER_SEC: f64 = 420e6;

static EFFECTIVE: Mutex<&str> = Mutex::new("compat");

fn config_dir() -> Option<PathBuf> {
    std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))
        .map(|d| d.join("io.github.tonearm.Tonearm"))
}

pub fn mode() -> String {
    if std::env::var_os("TONEARM_COMPAT_RENDERING").is_some() {
        return "compat".into();
    }
    let dir = config_dir();
    let saved = dir
        .as_ref()
        .and_then(|d| std::fs::read_to_string(d.join(MODE_FILE)).ok())
        .map(|s| s.trim().to_string());
    match saved.as_deref() {
        Some(m @ ("auto" | "full" | "compat")) => m.into(),
        _ => "auto".into(),
    }
}

/// Takes effect on the next launch.
pub fn set_mode(mode: &str) -> Result<(), String> {
    if !matches!(mode, "auto" | "full" | "compat") {
        return Err(format!("unknown render mode {mode}"));
    }
    let dir = config_dir().ok_or("no config directory")?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join(MODE_FILE), mode).map_err(|e| e.to_string())
}

/// What this launch is actually doing: "full", "even" or "compat".
pub fn effective() -> &'static str {
    *EFFECTIVE.lock().unwrap()
}

/// Must run before the first webview is created. A user-set variable always wins.
pub fn configure_env() {
    if mode() != "compat" && std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }
}

pub fn apply(window: &tauri::WebviewWindow) {
    let mode = mode();
    if mode == "compat" {
        return;
    }
    let full = mode == "full" || pixel_rate(window).is_none_or(|r| r <= FULL_RATE_PIXELS_PER_SEC);
    *EFFECTIVE.lock().unwrap() = if full { "full" } else { "even" };
    if !full {
        return; // WebKit's default pacing already gives the even divisor.
    }
    let _ = window.with_webview(|wv| {
        use webkit2gtk::glib::translate::ToGlibPtr;
        use webkit2gtk::WebViewExt;
        let view = wv.inner();
        let Some(settings) = view.settings() else { return };
        let ptr: *mut webkit2gtk::ffi::WebKitSettings = settings.to_glib_none().0;
        if !unsafe { disable_feature(ptr.cast(), c"PreferPageRenderingUpdatesNear60FPS") } {
            *EFFECTIVE.lock().unwrap() = "even";
            return;
        }
        // The web process reads its settings once at startup, so restart it.
        let uri = view.uri();
        view.terminate_web_process();
        match uri {
            Some(uri) => view.load_uri(&uri),
            None => view.reload(),
        }
    });
}

/// Device pixels the window would push per second at the full refresh rate.
fn pixel_rate(window: &tauri::WebviewWindow) -> Option<f64> {
    use gtk::prelude::*;
    let size = window.inner_size().ok()?;
    let gtk_window = window.gtk_window().ok()?;
    let gdk_window = gtk_window.window()?;
    let monitor = gdk_window.display().monitor_at_window(&gdk_window)?;
    let hz = monitor.refresh_rate() as f64 / 1000.0;
    (hz > 0.0).then(|| size.width as f64 * size.height as f64 * hz)
}

/// The feature API is WebKitGTK 2.42+, so it's looked up at runtime rather than linked.
unsafe fn disable_feature(settings: *mut c_void, id: &CStr) -> bool {
    unsafe fn sym<T: Copy>(name: &CStr) -> Option<T> {
        let p = libc::dlsym(libc::RTLD_DEFAULT, name.as_ptr());
        (!p.is_null()).then(|| std::mem::transmute_copy(&p))
    }
    type GetAll = unsafe extern "C" fn() -> *mut c_void;
    type Len = unsafe extern "C" fn(*mut c_void) -> usize;
    type Get = unsafe extern "C" fn(*mut c_void, usize) -> *mut c_void;
    type Ident = unsafe extern "C" fn(*mut c_void) -> *const c_char;
    type SetEnabled = unsafe extern "C" fn(*mut c_void, *mut c_void, i32);
    type Unref = unsafe extern "C" fn(*mut c_void);
    let (Some(get_all), Some(len), Some(get), Some(ident), Some(set_enabled), Some(unref)) = (
        sym::<GetAll>(c"webkit_settings_get_all_features"),
        sym::<Len>(c"webkit_feature_list_get_length"),
        sym::<Get>(c"webkit_feature_list_get"),
        sym::<Ident>(c"webkit_feature_get_identifier"),
        sym::<SetEnabled>(c"webkit_settings_set_feature_enabled"),
        sym::<Unref>(c"webkit_feature_list_unref"),
    ) else {
        return false;
    };
    let list = get_all();
    let mut found = false;
    for i in 0..len(list) {
        let feature = get(list, i);
        let name = ident(feature);
        if !name.is_null() && CStr::from_ptr(name) == id {
            set_enabled(settings, feature, 0);
            found = true;
            break;
        }
    }
    unref(list);
    found
}
