mod library;
mod remote;

#[cfg(desktop)]
mod desktop;
#[cfg(desktop)]
mod media;
#[cfg(desktop)]
mod player;
#[cfg(desktop)]
mod render;

#[cfg(mobile)]
mod mobile;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(desktop)]
    desktop::run();
    #[cfg(mobile)]
    mobile::run();
}
