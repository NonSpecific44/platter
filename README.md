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
- **Live library updates** through the server's notification socket, plus a refresh button (F5), and a library scan from Settings → Scan library (or Shift+F5)

**Autoplay and mixes**
- When the queue runs out, Platter keeps going with similar music. It uses Plex's sonic analysis when available, then artists with a similar sound (from MusicBrainz genre tags, learnt in the background), then Plex's similar artists, then albums in the same styles and genres. Random tracks are only a last resort. Turn it off in Settings → Playback.
- **Made for you** on Home: a **daylist** built from what you play at this time of day, renamed and remade through the day, and **Suggestions**: music you haven't heard much, near what you play most, remade daily.

**Devices (like Spotify Connect)**
- Every Platter on your account shows what your other devices are playing, with live progress. A "Listening on …" bar appears when music is playing somewhere else.
- **Play here** carries on with the same queue, track and position on this device and pauses the other one.
- The devices button lists your devices. Pick one to send your music there and control it from here; the player bar, queue and lyrics follow that device.
- One device plays at a time: starting music on one pauses Platter everywhere else (Settings → Playback).
- Idle devices are listed too: pick one before anything's playing, then choose music from any device and it plays there.
- With nothing playing on this device, the player shows whatever another device is playing ("Playing on …"), with play, pause, skip, back and scrubbing. Choose This device in Devices to stop following it.
- Exclusions and playback preferences (autoplay, crossfade, loudness levelling, saved EQ presets and so on) are shared between your devices. The EQ curve, output device and looks stay per device.
- Each Platter publishes its local network address to your Plex account, so devices find each other across subnets and on networks that drop multicast. Other Plex players do the same.
- Devices exchange their state every couple of seconds over the LAN. One working direction is enough, so a firewall on one side doesn't break it, though commands to a firewalled device can take a few seconds. Without any LAN link, Platter falls back to your Plex server's list of active sessions, which also shows other Plex apps.
- Speaks the Plex Companion protocol (HTTP on port 32500) with GDM discovery, so Plex apps can also see and control Platter.

**Android**
- Home, Search and Your Library tabs, a mini player, full-screen Now Playing, and bottom-sheet menus.
- Material design with Platter's colours, or choose Material You (wallpaper colours) or another colour scheme.
- Gestures: swipe down to minimise Now Playing, sideways to skip, right to go back. Press and drag the seek bar to scrub; waveform, wavy or plain.
- Android Auto with Albums, Artists and Playlists tabs and steering-wheel controls. Android Auto hides sideloaded apps until you turn on "Unknown sources" in its developer settings.
- Every server address is saved and checked at once, so moving between home and mobile data is quick. If the server stops answering, Platter moves to whichever address works and carries on.
- Pull down on any page to refresh it.
- Android 17 asks for permission to reach devices on your local network. Without it, Platter can only reach your server through its remote addresses and can't see other devices.
- **Built-in lossless decoders:** FLAC, ALAC, MP3, AAC, Vorbis and Opus play through Platter's own FFmpeg decoders, so files play the same on every device rather than depending on its maker's decoders. WAV is read directly. (AIFF isn't supported by the Android player and plays as a converted copy.)
- **Bit-perfect output** (Settings → Playback) for DAPs and hi-res DACs: 24-bit audio reaches the system untouched instead of being rounded to 16-bit, with the EQ, loudness levelling, crossfade and speed turned off.
- A track that won't play as it is falls back to a copy converted by Plex. Hi-res files are converted on Plex's relay, which can't carry them.
- Android 7 and newer, including older system WebViews.

**Google TV / Android TV**
- The same Android app, listed in the TV launcher, with the wide layout. Everything works with the remote's D-pad: arrows move between items, OK selects, Back goes back.

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

The Android app includes FFmpeg's audio decoders, built from source. Build them once (and again after changing FFmpeg or the decoder list) before the first Android build. This needs the SDK's `cmake;3.22.1` package:

```bash
packaging/build-ffmpeg.sh    # FFmpeg 6.0 into .build-tools/ffmpeg-src, for every Android ABI
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

MIT, apart from the parts below.

- The Android app's audio decoder module (`src-tauri/gen/android/ffmpeg-decoder`) is ExoPlayer's FFmpeg extension from [androidx/media](https://github.com/androidx/media) 1.8.0, under the Apache License 2.0.
- It's linked with [FFmpeg](https://ffmpeg.org) 6.0 (`libavcodec`, `libavutil`, `libswresample`), licensed under the [GNU LGPL 2.1 or later](https://www.gnu.org/licenses/old-licenses/lgpl-2.1.html). Only FFmpeg's LGPL parts are used, with nothing GPL or non-free. Its source is the `release/6.0` branch of https://git.ffmpeg.org/ffmpeg.git, and `packaging/build-ffmpeg.sh` rebuilds it exactly as the app uses it, so you can rebuild the app with a modified FFmpeg.
