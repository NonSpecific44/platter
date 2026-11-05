# Platter

*Formerly Tonearm.*

A Plex music player for the Linux desktop and Android. Each device can control the others, and the UI matches across platforms.

![Platter icon](public/icon.png)

## Features

**Playback**
- Gapless playback, ReplayGain (track/album) with pre-amp, 10-band EQ with presets, playback speed, output device picker (desktop, via libmpv)
- Native ExoPlayer playback on Android, with background playback, a media notification, lock-screen controls and headset buttons
- Queue with drag-and-drop, play next / add to queue, undo, smart shuffle (no back-to-back artists), repeat, stop after current track, and a sleep timer that fades out
- Optional transcoding for slow or remote connections

**Music on your device**
- Add local folders. Platter scans them, reads the tags, and looks up files with missing tags on MusicBrainz.
- Edit metadata in the app, with online search if a match fails. Where Android doesn't allow changing a file, the edit is kept inside Platter.
- If a song exists more than once, it's listed once. A local file beats streaming, and the best-quality copy wins. Plex still gets the play count.
- Download tracks and albums for offline listening.

**Requests**
- Link Lidarr (Settings) to search for and request artists and albums.

**Plex**
- Sign in with your Plex account, with automatic server discovery and reconnection
- Reports playback to Plex (Now Playing, play counts, *Recently played*) and saves your position. Long tracks resume where any Plex player left off.
- On launch, offers to carry on with whatever you last played on another device
- Loves and ratings sync both ways. Playlists can be created, edited and reordered.
- **Live library updates** through the server's notification socket, plus a refresh button (F5) that can also start a library scan (Shift+F5)

**Autoplay**
- When the queue runs out, Platter keeps going with similar music. It uses Plex's sonic analysis when available, then tracks by the same and similar artists, then the rest of your library. Turn it off in Settings → Playback.

**Devices (like Spotify Connect)**
- Every Platter on your account shows what your other devices are playing, with live progress. A "Listening on …" bar appears when music is playing somewhere else.
- **Play here** carries on with the same queue, track and position on this device and pauses the other one.
- The devices button lists your devices. Pick one to send your music there and control it from here; the player bar, queue and lyrics follow that device.
- One device plays at a time: starting music on one pauses Platter everywhere else (Settings → Playback).
- Devices exchange their state every couple of seconds over the LAN. One working direction is enough, so a firewall on one side doesn't break it. Without any LAN link, Platter falls back to your Plex server's list of active sessions, which also shows other Plex apps.
- Speaks the Plex Companion protocol (HTTP on port 32500) with GDM discovery, so Plex apps can also see and control Platter.

**Android**
- Home, Search and Your Library tabs, a mini player, full-screen Now Playing, and bottom-sheet menus.
- Material design with Platter's colours, or choose Material You (wallpaper colours) or another colour scheme.
- Gestures: swipe down to minimise Now Playing, sideways to skip, right to go back. Press and drag the seek bar to scrub; waveform, wavy or plain.
- Android Auto with Albums, Artists and Playlists tabs and steering-wheel controls. Android Auto hides sideloaded apps until you turn on "Unknown sources" in its developer settings.
- Every server address is saved and checked at once, so moving between home and mobile data is quick.
- Android 17 asks for permission to reach devices on your local network. Without it, Platter can only reach your server through its remote addresses and can't see other devices.
- Android 7 and newer, including older system WebViews.

**Sound**
- Crossfade (off by default), keeping albums gapless if you want.
- EQ presets on desktop and Android, plus your own saved ones.
- Loudness normalisation from Plex's analysis or ReplayGain tags, plus a live "dynamic" mode on desktop.
- Exclude tracks, albums or artists from autoplay, radio and library shuffle.

**Desktop**
- MPRIS (media keys, KDE/GNOME media controls), track-change notifications, tray icon, close to tray
- CLI controls: `platter --toggle | --next | --previous | --play | --pause | --stop`
- Mini player, full-screen Now Playing, synced lyrics (Plex or LRCLIB), waveform seek bar
- Keyboard shortcuts for everything (press `?`), command palette (`Ctrl+K`)
- Smooth scrolling at your monitor's refresh rate (Settings → Appearance → Frame rate)

## Install

Download from the [latest release](../../releases/latest):

| Platform | File |
| --- | --- |
| Arch / CachyOS / Manjaro | `platter-*-x86_64.pkg.tar.zst`, install with `sudo pacman -U platter-*.pkg.tar.zst` |
| Any Linux | `Platter_*_amd64.AppImage`, then `chmod +x` and run it |
| Android 7+ | `Platter-*-android.apk`, allow installs from your browser or file manager |

The Arch package needs `mpv` and `webkit2gtk-4.1` installed. The AppImage bundles what it needs, but running it requires FUSE (`fuse2` on Arch). If Platter won't start, check `~/.cache/platter/startup-error.log`, or run it from a terminal.

### Firewall (for remote control)

If a firewall is running (`ufw` is on by default on some distributions), devices can't find or reach each other until you allow Platter's ports. The Arch package ships a ufw profile:

```bash
sudo ufw allow Platter
```

That opens TCP 32500–32510 (remote-control server) and UDP 32412 and 32414 (discovery). Without a package, use:

```bash
sudo ufw allow 32500:32510/tcp && sudo ufw allow 32412/udp && sudo ufw allow 32414/udp
```

## Updates

Platter checks GitHub for new releases (Settings → Updates).
- **AppImage:** downloads the new version, verifies its signature against the key built into the app, and restarts.
- **Android:** downloads the new APK and opens the installer.
- **Arch package:** links to the release page.

Updates work without any setup while the repository is public. If it is ever made private, the app needs a GitHub token to see releases: create a fine-grained personal access token with read-only **Contents** access to this repository only, and paste it into Settings → Updates.

### Publishing a release

Updates are signed with the key in `.updater-signing/` (git-ignored, like the Android key; back up both).

```bash
export TAURI_SIGNING_PRIVATE_KEY="$(cat .updater-signing/platter-updater.key)"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$(cat .updater-signing/password)"
npx tauri build --bundles appimage    # also writes Platter_<version>_amd64.AppImage.sig
```

Attach the AppImage, the APK, the Arch package and a `latest.json` to the GitHub release. `latest.json` follows Tauri's updater format, and its platform `url` is the AppImage's API asset URL (`https://api.github.com/repos/<owner>/<repo>/releases/assets/<id>`).

## Building

You need Rust (stable), Node 20+, `mpv` and `webkit2gtk-4.1`.

```bash
npm ci
npx tauri dev                       # run in development
npx tauri build --no-bundle         # release binary in src-tauri/target/release/platter
cd packaging && makepkg -si         # Arch package
```

**AppImages must not be built directly on a distribution compiled for one CPU** (CachyOS's znver4 or v3/v4 repositories, for example). The AppImage bundles the build machine's libraries, and they'd crash on CPUs without those instructions. Build it in an Ubuntu 24.04 root instead, which needs no root access:

```bash
mkdir -p .build-tools/rootfs && cd .build-tools
curl -LO https://cdimage.ubuntu.com/ubuntu-base/releases/24.04/release/ubuntu-base-24.04.3-base-amd64.tar.gz
unshare -U --map-auto --map-root-user tar xzf ubuntu-base-24.04.3-base-amd64.tar.gz -C rootfs --exclude='dev/*'
cd .. && packaging/inroot.sh "$PWD" 'apt-get update && apt-get install -y build-essential curl file patchelf pkg-config libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev libmpv-dev libdbus-1-dev libssl-dev libxdo-dev'
# Then install Rust and Node 22 inside it, and:
packaging/inroot.sh "$PWD" 'bash /project/packaging/build-appimage.sh'   # result in dist-appimage/
```

A Flatpak manifest is in `packaging/flatpak` (it builds libmpv from source; see the comments at the top).

### Android

You also need JDK 17+, the Android SDK, and NDK 28 (`ANDROID_HOME`, `NDK_HOME` and `JAVA_HOME` set).

```bash
rustup target add aarch64-linux-android armv7-linux-androideabi
npx tauri android build --apk --target aarch64 armv7
```

Release builds are signed with the key described in `.android-signing/keystore.properties` (`storeFile`, `storePassword`, `keyAlias`, `keyPassword`). That folder is git-ignored. Keep the key safe: Android only installs an update if it's signed with the same key. Without it, Gradle produces an unsigned APK.

### Testing

`cargo test --lib` (in `src-tauri`) covers tags and file handling. `node tests/mock-plex.mjs` runs a stand-in Plex and Lidarr server with tone audio. Build with `VITE_TEST_PLEX=http://<host>:32400` to sign in to it automatically (`10.0.2.2` from the Android emulator).

## Project layout

- `src/` is the React + TypeScript UI, shared by desktop and Android:
  - `player.ts`: queue and playback logic
  - `plex.ts`: Plex API
  - `remote.ts`: device-to-device control
  - `live.ts`: library updates
- `src-tauri/src/` is the Rust side:
  - `desktop.rs`, `player.rs` (libmpv), `media.rs` (MPRIS, notifications), `render.rs` (frame rate)
  - `mobile.rs`: Android command bridge
  - `remote.rs`: companion HTTP server and GDM
- `src-tauri/gen/android/` is the Android project. `PlayerPlugin.kt` and `PlaybackService.kt` handle native playback.
- `packaging/` contains the PKGBUILD, Flatpak manifest, desktop entry and ufw profile.

## License

MIT
