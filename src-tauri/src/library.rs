//! Music on this device: folder scanning, tags, covers and downloads. Shared by desktop and
//! Android; the frontend keeps the resulting index and decides how to show it.

use lofty::config::WriteOptions;
use lofty::picture::{Picture, PictureType};
use lofty::prelude::*;
use lofty::read_from_path;
use lofty::tag::Tag;
use serde::{Deserialize, Serialize};
use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;
use tauri::{AppHandle, Emitter, Manager};

const AUDIO: &[&str] = &["flac", "mp3", "m4a", "aac", "ogg", "oga", "opus", "wav", "aif", "aiff", "wv", "ape", "mp4"];
const COVER_NAMES: &[&str] = &["cover", "folder", "front", "album", "artwork"];

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct LocalFile {
    path: String,
    mtime: u64,
    size: u64,
    title: String,
    artist: String,
    album_artist: String,
    album: String,
    track: Option<u32>,
    disc: Option<u32>,
    year: Option<u32>,
    genre: String,
    duration: u64,
    bitrate: u32,
    sample_rate: u32,
    bit_depth: u8,
    codec: String,
    gain: Option<f64>,
    album_gain: Option<f64>,
    cover: Option<String>,
    /// False when the file had no usable title/artist tags and these came from its name.
    tagged: bool,
}

#[derive(Serialize)]
pub struct ScanResult {
    changed: Vec<LocalFile>,
    present: Vec<String>,
}

fn hash(s: &str) -> String {
    let mut h = DefaultHasher::new();
    s.hash(&mut h);
    format!("{:016x}", h.finish())
}

fn cover_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let d = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("covers");
    std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    Ok(d)
}

fn parse_gain(s: Option<&str>) -> Option<f64> {
    s?.trim().trim_end_matches("dB").trim_end_matches("DB").trim().parse().ok()
}

/// "03 - Artist - Title.flac" or "Artist - Title.mp3": what a file name can tell us without tags.
fn from_file_name(path: &Path) -> (String, String) {
    let stem = path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let cleaned = stem.trim_start_matches(|c: char| c.is_ascii_digit() || c == ' ' || c == '.' || c == '-' || c == '_').trim().to_string();
    let cleaned = if cleaned.is_empty() { stem } else { cleaned };
    match cleaned.split_once(" - ") {
        Some((a, t)) => (a.trim().to_string(), t.trim().to_string()),
        None => (String::new(), cleaned),
    }
}

fn read_file(path: &Path, covers: &Path, mtime: u64, size: u64) -> LocalFile {
    let ext = path.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    let mut f = LocalFile { path: path.to_string_lossy().to_string(), mtime, size, codec: ext.clone(), ..Default::default() };
    let dir = path.parent().unwrap_or(path);
    let mut embedded: Option<Vec<u8>> = None;
    if let Ok(tagged) = read_from_path(path) {
        let props = tagged.properties();
        f.duration = props.duration().as_millis() as u64;
        f.bitrate = props.audio_bitrate().or(props.overall_bitrate()).unwrap_or(0);
        f.sample_rate = props.sample_rate().unwrap_or(0);
        f.bit_depth = props.bit_depth().unwrap_or(0);
        if let Some(tag) = tagged.primary_tag().or(tagged.first_tag()) {
            f.title = tag.title().unwrap_or_default().to_string();
            f.artist = tag.artist().unwrap_or_default().to_string();
            f.album = tag.album().unwrap_or_default().to_string();
            f.genre = tag.genre().unwrap_or_default().to_string();
            f.track = tag.track();
            f.disc = tag.disk();
            f.year = tag.date().map(|d| d.year as u32);
            f.album_artist = tag.get_string(ItemKey::AlbumArtist).unwrap_or_default().to_string();
            f.gain = parse_gain(tag.get_string(ItemKey::ReplayGainTrackGain));
            f.album_gain = parse_gain(tag.get_string(ItemKey::ReplayGainAlbumGain));
            embedded = tag.pictures().iter().find(|p| p.pic_type() == PictureType::CoverFront).or(tag.pictures().first()).map(|p| p.data().to_vec());
        }
    }
    f.tagged = !f.title.is_empty() && !f.artist.is_empty();
    if !f.tagged {
        let (artist, title) = from_file_name(path);
        if f.title.is_empty() {
            f.title = title;
        }
        if f.artist.is_empty() {
            f.artist = artist;
        }
    }
    if f.album.is_empty() {
        f.album = dir.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    }
    // One cover file per album rather than a copy per track.
    let key = hash(&format!("{}|{}", if f.album_artist.is_empty() { &f.artist } else { &f.album_artist }, f.album));
    let dest = covers.join(format!("{key}.img"));
    if dest.exists() {
        f.cover = Some(dest.to_string_lossy().to_string());
    } else if let Some(data) = embedded.or_else(|| folder_image(dir)) {
        if std::fs::write(&dest, data).is_ok() {
            f.cover = Some(dest.to_string_lossy().to_string());
        }
    }
    f
}

fn folder_image(dir: &Path) -> Option<Vec<u8>> {
    for entry in std::fs::read_dir(dir).ok()?.flatten() {
        let p = entry.path();
        let ext = p.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
        let stem = p.file_stem().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
        if matches!(ext.as_str(), "jpg" | "jpeg" | "png" | "webp") && COVER_NAMES.contains(&stem.as_str()) {
            return std::fs::read(p).ok();
        }
    }
    None
}

/// Walks the folders, re-reading only files whose modified time isn't in `known`.
#[tauri::command]
pub async fn local_scan(app: AppHandle, folders: Vec<String>, known: HashMap<String, u64>) -> Result<ScanResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let covers = cover_dir(&app)?;
        let mut result = ScanResult { changed: Vec::new(), present: Vec::new() };
        let mut seen = 0usize;
        for folder in &folders {
            for entry in walkdir::WalkDir::new(folder).follow_links(true).into_iter().flatten() {
                let path = entry.path();
                let ext = path.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
                if !entry.file_type().is_file() || !AUDIO.contains(&ext.as_str()) {
                    continue;
                }
                let Ok(meta) = entry.metadata() else { continue };
                let mtime = meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_secs()).unwrap_or(0);
                let key = path.to_string_lossy().to_string();
                result.present.push(key.clone());
                seen += 1;
                if seen % 50 == 0 {
                    let _ = app.emit("local://progress", seen);
                }
                if known.get(&key) != Some(&mtime) {
                    result.changed.push(read_file(path, &covers, mtime, meta.len()));
                }
            }
        }
        Ok(result)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TagEdit {
    title: String,
    artist: String,
    album_artist: String,
    album: String,
    track: Option<u32>,
    disc: Option<u32>,
    year: Option<u32>,
    genre: String,
}

fn write_tags(path: &str, e: &TagEdit) -> Result<(), String> {
    let mut tagged = read_from_path(path).map_err(|e| e.to_string())?;
    if tagged.primary_tag().is_none() {
        let kind = tagged.primary_tag_type();
        tagged.insert_tag(Tag::new(kind));
    }
    let tag = tagged.primary_tag_mut().ok_or("this file type can't hold tags")?;
    tag.set_title(e.title.clone());
    tag.set_artist(e.artist.clone());
    tag.set_album(e.album.clone());
    tag.set_genre(e.genre.clone());
    if e.album_artist.is_empty() {
        tag.remove_key(ItemKey::AlbumArtist);
    } else {
        tag.insert_text(ItemKey::AlbumArtist, e.album_artist.clone());
    }
    match e.track {
        Some(n) => tag.set_track(n),
        None => tag.remove_track(),
    }
    match e.disc {
        Some(n) => tag.set_disk(n),
        None => tag.remove_disk(),
    }
    match e.year {
        Some(y) => {
            tag.insert_text(ItemKey::Year, y.to_string());
            tag.insert_text(ItemKey::RecordingDate, y.to_string());
        }
        None => {
            tag.remove_key(ItemKey::Year);
            tag.remove_key(ItemKey::RecordingDate);
        }
    }
    tag.save_to_path(path, WriteOptions::default()).map_err(|e| e.to_string())
}

/// Writes tags into the file. Err means it couldn't (read-only, or Android's storage rules), and
/// the frontend keeps the edit in its own index instead.
#[tauri::command]
pub async fn local_write_tags(path: String, tags: TagEdit) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || write_tags(&path, &tags)).await.map_err(|e| e.to_string())?
}

fn get_bytes(url: &str, limit: u64) -> Result<Vec<u8>, String> {
    let resp = ureq::get(url).header("User-Agent", "Platter/0.3 (https://github.com/NonSpecific44/platter)").call().map_err(|e| e.to_string())?;
    let mut data = Vec::new();
    resp.into_body().into_reader().take(limit).read_to_end(&mut data).map_err(|e| e.to_string())?;
    Ok(data)
}

/// Downloads cover art, saves it for display and tries to embed it. Returns the saved path.
#[tauri::command]
pub async fn local_set_cover(app: AppHandle, path: String, url: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let data = get_bytes(&url, 20 << 20)?;
        let dest = cover_dir(&app)?.join(format!("{}.img", hash(&url)));
        std::fs::write(&dest, &data).map_err(|e| e.to_string())?;
        if let Ok(mut tagged) = read_from_path(&path) {
            if let Some(tag) = tagged.primary_tag_mut() {
                if let Ok(mut picture) = Picture::from_reader(&mut &data[..]) {
                    picture.set_pic_type(PictureType::CoverFront);
                    tag.remove_picture_type(PictureType::CoverFront);
                    tag.push_picture(picture);
                    let _ = tag.save_to_path(&path, WriteOptions::default());
                }
            }
        }
        Ok(dest.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

fn index_file(app: &AppHandle) -> Result<PathBuf, String> {
    let d = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    Ok(d.join("local-index.json"))
}

#[tauri::command]
pub fn local_index_load(app: AppHandle) -> Result<String, String> {
    match std::fs::read_to_string(index_file(&app)?) {
        Ok(s) => Ok(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub async fn local_index_save(app: AppHandle, json: String) -> Result<(), String> {
    let file = index_file(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let tmp = file.with_extension("tmp");
        std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, &file).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

fn downloads(app: &AppHandle) -> Result<PathBuf, String> {
    let d = app.path().app_data_dir().map_err(|e| e.to_string())?.join("downloads");
    std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    Ok(d)
}

#[tauri::command]
pub fn downloads_dir(app: AppHandle) -> Result<String, String> {
    Ok(downloads(&app)?.to_string_lossy().to_string())
}

fn safe_name(s: &str) -> String {
    let cleaned: String = s.chars().map(|c| if "/\\:*?\"<>|".contains(c) || c.is_control() { '_' } else { c }).collect();
    let t = cleaned.trim().trim_matches('.').to_string();
    if t.is_empty() { "Unknown".into() } else { t.chars().take(120).collect() }
}

/// Saves a track to `<data>/downloads/<artist>/<album>/<name>.<ext>`, atomically, so a dropped
/// connection doesn't leave half a file in the library.
#[tauri::command]
pub async fn download_track(app: AppHandle, url: String, artist: String, album: String, name: String, ext: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = downloads(&app)?.join(safe_name(&artist)).join(safe_name(&album));
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let dest = dir.join(format!("{}.{}", safe_name(&name), safe_name(&ext)));
        let tmp = dest.with_extension("part");
        let resp = ureq::get(&url).call().map_err(|e| e.to_string())?;
        let mut reader = resp.into_body().into_reader();
        let mut out = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
        std::io::copy(&mut reader, &mut out).map_err(|e| {
            let _ = std::fs::remove_file(&tmp);
            e.to_string()
        })?;
        std::fs::rename(&tmp, &dest).map_err(|e| e.to_string())?;
        Ok(dest.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Deletes a downloaded file. Refuses anything outside the downloads folder, so this can never
/// touch the user's own music.
#[tauri::command]
pub fn download_delete(app: AppHandle, path: String) -> Result<(), String> {
    let root = downloads(&app)?.canonicalize().map_err(|e| e.to_string())?;
    let file = Path::new(&path).canonicalize().map_err(|e| e.to_string())?;
    if !file.starts_with(&root) {
        return Err("not a downloaded file".into());
    }
    std::fs::remove_file(&file).map_err(|e| e.to_string())?;
    if let Some(album) = file.parent() {
        let _ = std::fs::remove_dir(album);
        if let Some(artist) = album.parent() {
            let _ = std::fs::remove_dir(artist);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A minimal valid mono WAV file.
    fn wav(path: &Path) {
        let samples = vec![0u8; 8000];
        let mut d = Vec::new();
        d.extend(b"RIFF");
        d.extend(&(36 + samples.len() as u32).to_le_bytes());
        d.extend(b"WAVEfmt ");
        d.extend(&16u32.to_le_bytes());
        d.extend(&1u16.to_le_bytes());
        d.extend(&1u16.to_le_bytes());
        d.extend(&8000u32.to_le_bytes());
        d.extend(&16000u32.to_le_bytes());
        d.extend(&2u16.to_le_bytes());
        d.extend(&16u16.to_le_bytes());
        d.extend(b"data");
        d.extend(&(samples.len() as u32).to_le_bytes());
        d.extend(&samples);
        std::fs::write(path, d).unwrap();
    }

    fn temp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("platter-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn untagged_files_take_names_from_the_file_and_folder() {
        let d = temp("names").join("Some Album");
        std::fs::create_dir_all(&d).unwrap();
        let f = d.join("03 - Some Artist - Some Song.wav");
        wav(&f);
        let r = read_file(&f, &d, 1, 1);
        assert_eq!(r.title, "Some Song");
        assert_eq!(r.artist, "Some Artist");
        assert_eq!(r.album, "Some Album");
        assert!(!r.tagged);
        assert_eq!(r.duration, 500);
    }

    #[test]
    fn edits_are_written_and_read_back() {
        let d = temp("tags");
        let f = d.join("a.wav");
        wav(&f);
        let edit = TagEdit {
            title: "T".into(),
            artist: "A".into(),
            album_artist: "AA".into(),
            album: "Al".into(),
            track: Some(4),
            disc: Some(2),
            year: Some(1999),
            genre: "G".into(),
        };
        write_tags(f.to_str().unwrap(), &edit).unwrap();
        let r = read_file(&f, &d, 1, 1);
        assert_eq!((r.title.as_str(), r.artist.as_str(), r.album.as_str()), ("T", "A", "Al"));
        assert_eq!(r.album_artist, "AA");
        assert_eq!((r.track, r.disc, r.year), (Some(4), Some(2), Some(1999)));
        assert!(r.tagged);
    }

    #[test]
    fn replaygain_values_parse() {
        assert_eq!(parse_gain(Some("-6.50 dB")), Some(-6.5));
        assert_eq!(parse_gain(Some("nonsense")), None);
    }

    #[test]
    fn file_names_stay_safe() {
        assert_eq!(safe_name("AC/DC: Live?"), "AC_DC_ Live_");
        assert_eq!(safe_name("..."), "Unknown");
    }
}
