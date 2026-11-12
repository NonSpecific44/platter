package io.github.tonearm.Tonearm

import android.Manifest
import android.app.Activity
import android.content.pm.PackageManager
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.media.audiofx.Equalizer
import android.media.audiofx.LoudnessEnhancer
import android.net.ConnectivityManager
import android.net.Network
import android.os.Environment
import androidx.media3.exoplayer.ExoPlayer
import org.json.JSONArray
import android.content.Intent
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import android.content.ComponentName
import android.content.Context
import android.net.Uri
import android.net.wifi.WifiManager
import android.os.Handler
import android.os.Looper
import android.webkit.WebView
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.PlaybackException
import androidx.media3.common.PlaybackParameters
import androidx.media3.common.Player
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import androidx.activity.result.ActivityResult
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import org.json.JSONObject
import android.util.Log
import androidx.annotation.OptIn
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.analytics.AnalyticsListener

@InvokeArg
class LoadArgs {
  lateinit var url: String
  var next: String? = null
  var start: Double = 0.0
  var paused: Boolean = false
}

@InvokeArg
class NextArgs {
  var next: String? = null
}

@InvokeArg
class SeekArgs {
  var seconds: Double = 0.0
}

@InvokeArg
class PropArgs {
  lateinit var name: String
  var value: String = ""
}

@InvokeArg
class UpdateArgs {
  lateinit var url: String
  var token: String? = null
}

@InvokeArg
class CrossfadeArgs {
  lateinit var url: String
  var next: String? = null
  var seconds: Double = 6.0
}

@InvokeArg
class BarsArgs {
  lateinit var color: String
  var dark: Boolean = true
}

@InvokeArg
class ConfigArgs {
  lateinit var json: String
}

@InvokeArg
class MetaArgs {
  var title: String = ""
  var artist: String = ""
  var album: String = ""
  var duration: Double = 0.0
  var coverUrl: String? = null
}

/**
 * Android audio backend. Mirrors the desktop mpv backend's commands and events so the shared
 * frontend drives both the same way: the current track plus the next one are queued in ExoPlayer
 * (for gapless playback) and everything else (the queue, shuffle, scrobbling) lives in JS.
 *
 * Events go straight into the page as `window.__tonearmNative(event, payload)`.
 */
@TauriPlugin
class PlayerPlugin(private val activity: Activity) : Plugin(activity) {
  private val main = Handler(Looper.getMainLooper())
  private var webView: WebView? = null
  private var controller: MediaController? = null
  private var multicastLock: WifiManager.MulticastLock? = null
  private var attached: ExoPlayer? = null
  private val player get() = PlaybackService.player(activity.applicationContext)
  private var foreground = true

  override fun load(webView: WebView) {
    this.webView = webView
    attach(player)
    PlaybackService.onControl = { action -> emit("control", JSONObject().put("action", action)) }
    // Binding a controller starts the session service, which shows the media notification.
    val token = SessionToken(activity, ComponentName(activity, PlaybackService::class.java))
    val future = MediaController.Builder(activity, token).buildAsync()
    future.addListener({ controller = runCatching { future.get() }.getOrNull() }, { main.post(it) })
    // Lets other Platters find this one (GDM discovery is multicast). Only held while the app is
    // on screen: it keeps the Wi-Fi radio busier, which costs battery.
    val wifi = activity.applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
    multicastLock = wifi?.createMulticastLock("platter-discovery")?.apply {
      setReferenceCounted(false)
      acquire()
    }
    watchNetwork()
    watchOutput()
    schedule()
  }

  override fun onPause() {
    foreground = false
    multicastLock?.let { if (it.isHeld) it.release() }
  }

  override fun onResume() {
    // Back from the permission prompt: carry on to the folder browser.
    pendingPick?.let {
      pendingPick = null
      openFolderBrowser(it)
    }
    foreground = true
    multicastLock?.let { if (!it.isHeld) it.acquire() }
    schedule()
  }

  private fun attach(p: ExoPlayer) {
    attached?.removeListener(listener)
    p.addListener(listener)
    p.addAnalyticsListener(decoderLog)
    attached = p
    applyEffects()
    applyVolume()
  }

  private fun emit(event: String, payload: Any) {
    val js = "window.__tonearmNative && window.__tonearmNative(${JSONObject.quote(event)}, $payload)"
    main.post { webView?.evaluateJavascript(js, null) }
  }

  private fun stateJson(): JSONObject {
    val p = player
    val idle = p.playbackState == Player.STATE_IDLE || p.playbackState == Player.STATE_ENDED || p.mediaItemCount == 0
    val dur = p.duration
    return JSONObject()
      .put("position", p.currentPosition / 1000.0)
      .put("duration", if (dur > 0) dur / 1000.0 else 0.0)
      .put("paused", !p.playWhenReady)
      .put("idle", idle)
      .put("volume", (PlaybackService.volume * 100).toDouble())
      .put("muted", PlaybackService.muted)
      .put("buffering", p.playbackState == Player.STATE_BUFFERING)
  }

  private var lastState = ""
  private var ticking = false

  /** Position updates only while playing, and slowly when nobody's looking at the screen. */
  private val ticker = object : Runnable {
    override fun run() {
      val s = stateJson()
      val key = s.toString()
      if (key != lastState) {
        lastState = key
        emit("state", s)
      }
      if (player.isPlaying) {
        main.postDelayed(this, if (foreground) 500 else 2000)
      } else {
        ticking = false
      }
    }
  }

  private fun schedule() {
    if (ticking) return
    ticking = true
    main.post(ticker)
  }

  private val listener = object : Player.Listener {
    override fun onMediaItemTransition(item: MediaItem?, reason: Int) {
      val uri = item?.localConfiguration?.uri?.toString() ?: return
      if (PlaybackService.nativeQueue) {
        // Android Auto started this queue while the app is open: the app takes it over.
        emit("external", takeOverJson() ?: "null")
        return
      }
      emit("file", JSONObject.quote(uri))
      // Keep only the current item and whatever follows it, like the desktop backend.
      val p = player
      if (p.currentMediaItemIndex > 0) p.removeMediaItems(0, p.currentMediaItemIndex)
    }

    override fun onPlaybackStateChanged(state: Int) {
      if (state == Player.STATE_ENDED) emit("idle", "null")
      emit("state", stateJson())
      schedule()
    }

    override fun onIsPlayingChanged(isPlaying: Boolean) {
      emit("state", stateJson())
      schedule()
    }

    override fun onAudioSessionIdChanged(audioSessionId: Int) = applyEffects()

    override fun onPlayerError(error: PlaybackException) {
      // "Source error" alone says nothing; the code and cause say what actually went wrong.
      val cause = error.cause?.let { c -> c.message?.takeIf { it.isNotBlank() } ?: c.javaClass.simpleName }
      val detail = listOfNotNull(error.errorCodeName.removePrefix("ERROR_CODE_"), cause).joinToString(": ")
      emit("error", JSONObject.quote("${error.message ?: "Playback error"} ($detail)"))
    }
  }

  /** The queue Android Auto is playing, for the app to take over. */
  private fun takeOverJson(): String? {
    val p = player
    if (!PlaybackService.nativeQueue || p.mediaItemCount == 0) return null
    val tracks = JSONArray()
    for (i in 0 until p.mediaItemCount) {
      val raw = p.getMediaItemAt(i).mediaMetadata.extras?.getString(AutoLibrary.EXTRA_JSON) ?: return null
      tracks.put(JSONObject(raw))
    }
    return JSONObject()
      .put("tracks", tracks)
      .put("index", p.currentMediaItemIndex)
      .put("position", p.currentPosition / 1000.0)
      .put("paused", !p.playWhenReady)
      .toString()
  }

  @Command
  fun takeOver(invoke: Invoke) {
    main.post { invoke.resolve(JSObject().put("value", takeOverJson().orEmpty())) }
  }

  // ---- effects -----------------------------------------------------------------------------

  private var eqConfig: JSONObject? = null
  private var gainDb = 0.0
  private var equalizer: Equalizer? = null
  private var enhancer: LoudnessEnhancer? = null
  private var effectsSession = 0

  /** The system equaliser has its own bands; each takes the setting closest to its frequency. */
  private fun applyEffects() {
    val session = runCatching { player.audioSessionId }.getOrDefault(0)
    if (session <= 0) return
    try {
      if (session != effectsSession) {
        equalizer?.release()
        enhancer?.release()
        equalizer = null
        enhancer = null
        effectsSession = session
      }
      val cfg = eqConfig.takeUnless { PlaybackService.bitPerfect }
      if (cfg == null) {
        equalizer?.enabled = false
      } else {
        val eq = equalizer ?: Equalizer(0, session).also { equalizer = it }
        val bands = cfg.getJSONArray("bands")
        val preamp = cfg.optDouble("preamp", 0.0)
        val range = eq.bandLevelRange
        for (b in 0 until eq.numberOfBands) {
          val hz = eq.getCenterFreq(b.toShort()) / 1000.0
          var best = 0.0
          var bestDistance = Double.MAX_VALUE
          for (i in 0 until bands.length()) {
            val pair = bands.getJSONArray(i)
            val d = Math.abs(Math.log(pair.getDouble(0) / hz))
            if (d < bestDistance) {
              bestDistance = d
              best = pair.getDouble(1)
            }
          }
          val mb = ((best + preamp) * 100).toInt().coerceIn(range[0].toInt(), range[1].toInt())
          eq.setBandLevel(b.toShort(), mb.toShort())
        }
        eq.enabled = true
      }
      if (PlaybackService.bitPerfect) {
        enhancer?.enabled = false
        return
      }
      val le = enhancer ?: if (gainDb > 0) LoudnessEnhancer(session).also { enhancer = it } else null
      le?.setTargetGain(((if (gainDb > 0) gainDb else 0.0) * 100).toInt())
      le?.enabled = gainDb > 0
    } catch (e: Exception) {
      // Some devices don't offer these effects; playback carries on without them.
    }
  }

  /** ExoPlayer can only turn down, so cuts go through volume and boosts through the enhancer. */
  private fun applyVolume(fade: Float = 1f) {
    val base = if (PlaybackService.muted) 0f else PlaybackService.volume
    val cut = if (gainDb < 0 && !PlaybackService.bitPerfect) Math.pow(10.0, gainDb / 20.0).toFloat() else 1f
    player.volume = base * cut * fade
  }

  // ---- crossfade -----------------------------------------------------------------------------

  private var fadeGeneration = 0
  private var outgoing: ExoPlayer? = null

  private fun cancelFade() {
    fadeGeneration++
    outgoing?.release()
    outgoing = null
    applyVolume()
  }

  /** Which decoder each track uses, for checking that FFmpeg's are in use. */
  @OptIn(UnstableApi::class)
  private val decoderLog = object : AnalyticsListener {
    override fun onAudioDecoderInitialized(eventTime: AnalyticsListener.EventTime, decoderName: String, initializedTimestampMs: Long, initializationDurationMs: Long) {
      Log.i("Platter", "audio decoder: $decoderName")
    }
  }

  /** Starts [CrossfadeArgs.url] on a second player, ramps across, then releases the first. */
  @Command
  fun crossfade(invoke: Invoke) {
    val args = invoke.parseArgs(CrossfadeArgs::class.java)
    onMain(invoke) {
      cancelFade()
      val gen = fadeGeneration
      val old = player
      old.clearMediaItems(keepCurrent = true)
      val next = PlaybackService.newPlayer(activity.applicationContext, handleFocus = false)
      next.volume = 0f
      next.setMediaItem(item(args.url))
      args.next?.let { next.addMediaItem(item(it)) }
      next.playWhenReady = true
      next.prepare()
      old.removeListener(listener)
      outgoing = old
      PlaybackService.swapPlayer(next)
      attach(next)
      next.volume = 0f
      val total = (args.seconds * 1000).toLong().coerceAtLeast(100)
      val startVolume = old.volume
      var elapsed = 0L
      main.post(object : Runnable {
        override fun run() {
          if (gen != fadeGeneration) return
          if (next.isPlaying) elapsed += 50
          val x = (elapsed.toFloat() / total).coerceIn(0f, 1f)
          old.volume = startVolume * (1f - x)
          applyVolume(x)
          if (x < 1f) {
            main.postDelayed(this, 50)
          } else {
            old.release()
            outgoing = null
            PlaybackService.takeFocus(next)
          }
        }
      })
    }
  }

  /** A fresh player built for the current output mode, in place of the old one. */
  private fun rebuildPlayer() {
    val old = player
    val fresh = PlaybackService.newPlayer(activity.applicationContext)
    old.removeListener(listener)
    PlaybackService.swapPlayer(fresh)
    attach(fresh)
    old.release()
    applyEffects()
  }

  private fun ExoPlayer.clearMediaItems(keepCurrent: Boolean) {
    if (keepCurrent && mediaItemCount > currentMediaItemIndex + 1) removeMediaItems(currentMediaItemIndex + 1, mediaItemCount)
  }

  // ---- device state --------------------------------------------------------------------------

  private fun watchNetwork() {
    val cm = activity.applicationContext.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return
    cm.registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
      override fun onAvailable(network: Network) = emit("network", "null")
      override fun onLost(network: Network) = emit("network", "null")
    })
  }

  /** Headphones and other outputs, by name. */
  private fun currentOutput(am: AudioManager): String? {
    val outputs = am.getDevices(AudioManager.GET_DEVICES_OUTPUTS)
    val order = listOf(
      AudioDeviceInfo.TYPE_BLUETOOTH_A2DP, AudioDeviceInfo.TYPE_BLE_HEADSET, AudioDeviceInfo.TYPE_BLE_SPEAKER,
      AudioDeviceInfo.TYPE_USB_HEADSET, AudioDeviceInfo.TYPE_USB_DEVICE, AudioDeviceInfo.TYPE_WIRED_HEADSET, AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
    )
    for (type in order) {
      val d = outputs.firstOrNull { it.type == type } ?: continue
      val name = d.productName?.toString().orEmpty()
      val wired = type == AudioDeviceInfo.TYPE_WIRED_HEADSET || type == AudioDeviceInfo.TYPE_WIRED_HEADPHONES
      return if (wired || name.isBlank() || name == Build.MODEL) "Wired headphones" else name
    }
    return null
  }

  private fun watchOutput() {
    val am = activity.applicationContext.getSystemService(Context.AUDIO_SERVICE) as? AudioManager ?: return
    val report = { emit("output", JSONObject.quote(currentOutput(am).orEmpty())) }
    am.registerAudioDeviceCallback(object : AudioDeviceCallback() {
      override fun onAudioDevicesAdded(added: Array<out AudioDeviceInfo>?) { report() }
      override fun onAudioDevicesRemoved(removed: Array<out AudioDeviceInfo>?) { report() }
    }, main)
    report()
  }

  // ---- system bits ---------------------------------------------------------------------------

  /** Leaves the app running behind whatever's next, so music keeps playing. */
  @Command
  fun background(invoke: Invoke) {
    onMain(invoke) { activity.moveTaskToBack(true) }
  }

  /** Colours the strips behind the status and navigation bars to match the theme. */
  @Command
  fun systemBars(invoke: Invoke) {
    val args = invoke.parseArgs(BarsArgs::class.java)
    onMain(invoke) {
      activity.findViewById<android.view.View>(android.R.id.content).setBackgroundColor(android.graphics.Color.parseColor(args.color))
      androidx.core.view.WindowInsetsControllerCompat(activity.window, activity.window.decorView).apply {
        isAppearanceLightStatusBars = !args.dark
        isAppearanceLightNavigationBars = !args.dark
      }
    }
  }

  @Command
  fun autoConfig(invoke: Invoke) {
    val args = invoke.parseArgs(ConfigArgs::class.java)
    AutoLibrary.saveConfig(activity.applicationContext, args.json)
    invoke.resolve()
  }

  /** Wallpaper-based Material You colours (Android 12+). */
  @Command
  fun dynamicColors(invoke: Invoke) {
    val o = JSObject()
    if (Build.VERSION.SDK_INT >= 31) {
      val c = activity.applicationContext
      val hex = { id: Int -> String.format("#%06x", c.getColor(id) and 0xffffff) }
      o.put("a200", hex(android.R.color.system_accent1_200))
      o.put("a600", hex(android.R.color.system_accent1_600))
      o.put("n10", hex(android.R.color.system_neutral1_10))
      o.put("n50", hex(android.R.color.system_neutral1_50))
      o.put("n100", hex(android.R.color.system_neutral2_100))
      o.put("n200", hex(android.R.color.system_neutral2_200))
      o.put("n700", hex(android.R.color.system_neutral2_700))
      o.put("n800", hex(android.R.color.system_neutral2_800))
      o.put("n900", hex(android.R.color.system_neutral1_900))
    }
    invoke.resolve(o)
  }

  /**
   * The system's folder browser. The scanner reads ordinary paths through the audio permission, so
   * the chosen tree is converted back to one. The permission prompt comes first, then the browser.
   */
  @Command
  fun pickFolder(invoke: Invoke) {
    val perm = if (Build.VERSION.SDK_INT >= 33) Manifest.permission.READ_MEDIA_AUDIO else Manifest.permission.READ_EXTERNAL_STORAGE
    if (activity.checkSelfPermission(perm) == PackageManager.PERMISSION_GRANTED) {
      openFolderBrowser(invoke)
    } else {
      pendingPick = invoke
      activity.requestPermissions(arrayOf(perm), 2)
    }
  }

  private var pendingPick: Invoke? = null

  private fun openFolderBrowser(invoke: Invoke) {
    startActivityForResult(invoke, Intent(Intent.ACTION_OPEN_DOCUMENT_TREE), "folderPicked")
  }

  @ActivityCallback
  fun folderPicked(invoke: Invoke, result: ActivityResult) {
    val tree = result.data?.data
    if (result.resultCode != Activity.RESULT_OK || tree == null) {
      invoke.resolve(JSObject().put("value", ""))
      return
    }
    val path = treeToPath(tree)
    if (path == null) invoke.reject("That location can't be used. Choose a folder on this device or its SD card.")
    else invoke.resolve(JSObject().put("value", path))
  }

  private fun treeToPath(tree: Uri): String? {
    val id = android.provider.DocumentsContract.getTreeDocumentId(tree)
    if (id.startsWith("raw:")) return id.removePrefix("raw:")
    val volume = id.substringBefore(':')
    val rel = id.substringAfter(':', "")
    val root = when {
      volume == "primary" -> Environment.getExternalStorageDirectory().absolutePath
      volume == "home" -> Environment.getExternalStorageDirectory().absolutePath + "/Documents"
      Regex("[0-9A-Fa-f-]+").matches(volume) -> "/storage/$volume"
      else -> return null
    }
    return if (rel.isEmpty()) root else "$root/$rel"
  }

  private fun item(url: String) = MediaItem.Builder().setUri(Uri.parse(url)).setMediaId(url).build()

  private fun onMain(invoke: Invoke, block: () -> Unit) {
    main.post {
      try {
        block()
        invoke.resolve()
      } catch (e: Exception) {
        invoke.reject(e.message ?: e.toString())
      }
    }
  }

  @Command
  fun load(invoke: Invoke) {
    val args = invoke.parseArgs(LoadArgs::class.java)
    onMain(invoke) {
      cancelFade()
      PlaybackService.nativeQueue = false
      if (PlaybackService.builtBitPerfect != PlaybackService.bitPerfect) rebuildPlayer()
      val p = player
      val items = mutableListOf(item(args.url))
      args.next?.let { items.add(item(it)) }
      p.setMediaItems(items, 0, (args.start * 1000).toLong())
      p.playWhenReady = !args.paused
      p.prepare()
      schedule()
      emit("file", JSONObject.quote(args.url))
    }
  }

  @Command
  fun setNext(invoke: Invoke) {
    val args = invoke.parseArgs(NextArgs::class.java)
    onMain(invoke) {
      val p = player
      val cur = p.currentMediaItemIndex
      if (p.mediaItemCount > cur + 1) p.removeMediaItems(cur + 1, p.mediaItemCount)
      args.next?.let { p.addMediaItem(item(it)) }
    }
  }

  @Command
  fun stop(invoke: Invoke) {
    onMain(invoke) {
      cancelFade()
      PlaybackService.nativeQueue = false
      player.stop()
      player.clearMediaItems()
      emit("idle", "null")
    }
  }

  @Command
  fun seek(invoke: Invoke) {
    val args = invoke.parseArgs(SeekArgs::class.java)
    onMain(invoke) { player.seekTo((args.seconds * 1000).toLong()) }
  }

  @Command
  fun set(invoke: Invoke) {
    val args = invoke.parseArgs(PropArgs::class.java)
    onMain(invoke) {
      val p = player
      when (args.name) {
        "pause" -> p.playWhenReady = args.value != "yes"
        "volume" -> {
          PlaybackService.volume = ((args.value.toDoubleOrNull() ?: 100.0).toFloat() / 100f).coerceIn(0f, 1f)
          applyVolume()
        }
        "mute" -> {
          PlaybackService.muted = args.value == "yes"
          applyVolume()
        }
        "volume-gain" -> {
          gainDb = args.value.toDoubleOrNull() ?: 0.0
          applyEffects()
          applyVolume()
        }
        "eq" -> {
          eqConfig = runCatching { JSONObject(args.value) }.getOrNull()
          applyEffects()
        }
        "bit-perfect" -> {
          PlaybackService.bitPerfect = args.value == "yes"
          // Takes effect straight away unless something's playing; otherwise from the next track.
          if (PlaybackService.builtBitPerfect != PlaybackService.bitPerfect && !p.isPlaying) rebuildPlayer()
          applyEffects()
          applyVolume()
        }
        "speed" -> p.playbackParameters = PlaybackParameters(args.value.toFloatOrNull() ?: 1f)
        "loop-file" -> p.repeatMode = if (args.value == "inf") Player.REPEAT_MODE_ONE else Player.REPEAT_MODE_OFF
        // mpv-only settings (filter graph, ReplayGain tags, output device, gapless mode) have no
        // equivalent here; ExoPlayer is always gapless.
        else -> {}
      }
    }
  }

  @Command
  fun get(invoke: Invoke) {
    val args = invoke.parseArgs(PropArgs::class.java)
    main.post {
      val value = when (args.name) {
        "audio-device-list" -> "[]"
        else -> ""
      }
      invoke.resolve(JSObject().put("value", value))
    }
  }

  @Command
  fun metadata(invoke: Invoke) {
    val args = invoke.parseArgs(MetaArgs::class.java)
    onMain(invoke) {
      val p = player
      val cur = p.currentMediaItem ?: return@onMain
      val meta = MediaMetadata.Builder()
        .setTitle(args.title)
        .setArtist(args.artist)
        .setAlbumTitle(args.album)
        .setArtworkUri(args.coverUrl?.let { Uri.parse(it) })
        .build()
      p.replaceMediaItem(p.currentMediaItemIndex, cur.buildUpon().setMediaMetadata(meta).build())
    }
  }

  /**
   * Downloads a release APK and opens the system installer. Android itself refuses the update
   * unless it's signed with the same key as the installed app.
   */
  @Command
  fun installUpdate(invoke: Invoke) {
    val args = invoke.parseArgs(UpdateArgs::class.java)
    if (Build.VERSION.SDK_INT >= 26 && !activity.packageManager.canRequestPackageInstalls()) {
      activity.startActivity(
        Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${activity.packageName}"))
          .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
      )
      invoke.reject("Allow Tonearm to install apps, then tap Update again")
      return
    }
    Thread {
      try {
        val file = File(activity.cacheDir, "tonearm-update.apk")
        download(args.url, args.token, file)
        val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.fileprovider", file)
        val intent = Intent(Intent.ACTION_VIEW)
          .setDataAndType(uri, "application/vnd.android.package-archive")
          .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        main.post { activity.startActivity(intent) }
        invoke.resolve()
      } catch (e: Exception) {
        invoke.reject(e.message ?: e.toString())
      }
    }.start()
  }

  /** GitHub redirects asset downloads to storage that rejects the token, so follow by hand. */
  private fun download(start: String, token: String?, dest: File) {
    var url = start
    var auth = !token.isNullOrBlank()
    repeat(5) {
      val conn = URL(url).openConnection() as HttpURLConnection
      conn.instanceFollowRedirects = false
      conn.setRequestProperty("Accept", "application/octet-stream")
      if (auth) conn.setRequestProperty("Authorization", "Bearer ${token!!.trim()}")
      val code = conn.responseCode
      if (code in 300..399) {
        url = conn.getHeaderField("Location") ?: throw Exception("Bad redirect")
        auth = false
        conn.disconnect()
        return@repeat
      }
      if (code != 200) throw Exception("Download failed ($code)")
      conn.inputStream.use { input -> dest.outputStream().use { input.copyTo(it) } }
      return
    }
    throw Exception("Too many redirects")
  }
}
