# Tonearm

A Plex music player for the Linux desktop and Android. Each device can control the others, and the UI matches across platforms.

![Tonearm icon](public/icon.png)

## Features

**Playback**
- Gapless playback, ReplayGain (track/album) with pre-amp, 10-band EQ with presets, playback speed, output device picker (desktop, via libmpv)
- Native ExoPlayer playback on Android, with background playback, a media notification, lock-screen controls and headset buttons
- Queue with drag-and-drop, play next / add to queue, undo, smart shuffle (no back-to-back artists), repeat, stop after current track, and a sleep timer that fades out
- Optional transcoding for slow or remote connections

**Plex**
- Sign in with your Plex account, with automatic server discovery and reconnection
- Reports playback to Plex (Now Playing, play counts, *Recently played*) and saves your position. Long tracks resume where any Plex player left off.
- On launch, offers to carry on with whatever you last played on another device
- Loves and ratings sync both ways. Playlists can be created, edited and reordered.
- **Live library updates** through the server's notification socket, plus a refresh button (F5) that can also start a library scan (Shift+F5)

**Autoplay**
- When the queue runs out, Tonearm keeps going with similar music. It uses Plex's sonic analysis when available, then tracks by the same and similar artists, then the rest of your library. Turn it off in Settings → Playback.

**Remote control**
- The devices button in the player bar lists other Tonearms on your network. Pick one to control it: the player bar, queue and lyrics follow that device.
- If music is playing on this device, picking another one moves playback there and continues from the same point. "Move playback to this device" brings it back.
- When another Tonearm is already playing, Tonearm offers to control it.
- One device plays at a time: starting music on one pauses Tonearm everywhere else (Settings → Playback).
- Uses the Plex Companion protocol (HTTP on port 32500) and GDM discovery, so Plex apps can also see and control Tonearm.

**Desktop**
- MPRIS (media keys, KDE/GNOME media controls), track-change notifications, tray icon, close to tray
- CLI controls: `tonearm --toggle | --next | --previous | --play | --pause | --stop`
- Mini player, full-screen Now Playing, synced lyrics (Plex or LRCLIB), waveform seek bar
- Keyboard shortcuts for everything (press `?`), command palette (`Ctrl+K`)
- Smooth scrolling at your monitor's refresh rate (Settings → Appearance → Frame rate)

## Install

Download from the [latest release](../../releases/latest):

| Platform | File |
| --- | --- |
| Arch / CachyOS / Manjaro | `tonearm-*-x86_64.pkg.tar.zst`, install with `sudo pacman -U tonearm-*.pkg.tar.zst` |
| Any Linux | `Tonearm_*_amd64.AppImage`, then `chmod +x` and run it |
| Android 7+ (arm64) | `Tonearm-*-android-arm64.apk`, allow installs from your browser or file manager |

The Arch package and AppImage need `mpv` (libmpv) and `webkit2gtk-4.1` installed.

### Firewall (for remote control)

If a firewall is running (`ufw` is on by default on some distributions), devices can't find or reach each other until you allow Tonearm's ports. The Arch package ships a ufw profile:

```bash
sudo ufw allow Tonearm
```

That opens TCP 32500–32510 (remote-control server) and UDP 32412 and 32414 (discovery). Without a package, use:

```bash
sudo ufw allow 32500:32510/tcp && sudo ufw allow 32412/udp && sudo ufw allow 32414/udp
```

## Updates

Tonearm checks GitHub for new releases (Settings → Updates).
- **AppImage:** downloads the new version, verifies its signature against the key built into the app, and restarts.
- **Android:** downloads the new APK and opens the installer.
- **Arch package:** links to the release page.

While the repository is private, the app needs a GitHub token to see releases. Create a fine-grained personal access token with read-only **Contents** access to this repository only, and paste it into Settings → Updates.

### Publishing a release

Updates are signed with the key in `.updater-signing/` (git-ignored, like the Android key; back up both).

```bash
export TAURI_SIGNING_PRIVATE_KEY="$(cat .updater-signing/tonearm-updater.key)"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$(cat .updater-signing/password)"
npx tauri build --bundles appimage    # also writes Tonearm_<version>_amd64.AppImage.sig
```

Attach the AppImage, the APK, the Arch package and a `latest.json` to the GitHub release. `latest.json` follows Tauri's updater format, and its platform `url` is the AppImage's API asset URL (`https://api.github.com/repos/<owner>/<repo>/releases/assets/<id>`).

## Building

You need Rust (stable), Node 20+, `mpv` and `webkit2gtk-4.1`.

```bash
npm ci
npx tauri dev                       # run in development
npx tauri build --no-bundle         # release binary in src-tauri/target/release/tonearm
cd packaging && makepkg -si         # Arch package
npx tauri build --bundles appimage  # AppImage
```

A Flatpak manifest is in `packaging/flatpak` (it builds libmpv from source; see the comments at the top).

### Android

You also need JDK 17+, the Android SDK, and NDK 28 (`ANDROID_HOME`, `NDK_HOME` and `JAVA_HOME` set).

```bash
rustup target add aarch64-linux-android
npx tauri android build --apk --target aarch64
```

Release builds are signed with the key described in `.android-signing/keystore.properties` (`storeFile`, `storePassword`, `keyAlias`, `keyPassword`). That folder is git-ignored. Keep the key safe: Android only installs an update if it's signed with the same key. Without it, Gradle produces an unsigned APK.

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
