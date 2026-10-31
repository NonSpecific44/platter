package io.github.tonearm.Tonearm

import android.app.Activity
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
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import org.json.JSONObject

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
  private val player get() = PlaybackService.player(activity.applicationContext)

  override fun load(webView: WebView) {
    this.webView = webView
    val p = player
    p.addListener(listener)
    PlaybackService.onControl = { action -> emit("control", JSONObject().put("action", action)) }
    // Binding a controller starts the session service, which shows the media notification.
    val token = SessionToken(activity, ComponentName(activity, PlaybackService::class.java))
    val future = MediaController.Builder(activity, token).buildAsync()
    future.addListener({ controller = runCatching { future.get() }.getOrNull() }, { main.post(it) })
    // Lets other Tonearms find this one (GDM discovery is multicast).
    val wifi = activity.applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
    multicastLock = wifi?.createMulticastLock("tonearm-discovery")?.apply {
      setReferenceCounted(false)
      acquire()
    }
    main.post(ticker)
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

  /** Position updates while playing; any other change goes out as soon as it happens. */
  private val ticker = object : Runnable {
    override fun run() {
      val s = stateJson()
      val key = s.toString()
      if (key != lastState) {
        lastState = key
        emit("state", s)
      }
      main.postDelayed(this, 250)
    }
  }

  private val listener = object : Player.Listener {
    override fun onMediaItemTransition(item: MediaItem?, reason: Int) {
      val uri = item?.localConfiguration?.uri?.toString() ?: return
      emit("file", JSONObject.quote(uri))
      // Keep only the current item and whatever follows it, like the desktop backend.
      val p = player
      if (p.currentMediaItemIndex > 0) p.removeMediaItems(0, p.currentMediaItemIndex)
    }

    override fun onPlaybackStateChanged(state: Int) {
      if (state == Player.STATE_ENDED) emit("idle", "null")
      emit("state", stateJson())
    }

    override fun onIsPlayingChanged(isPlaying: Boolean) {
      emit("state", stateJson())
    }

    override fun onPlayerError(error: PlaybackException) {
      emit("error", JSONObject.quote(error.message ?: "playback error"))
    }
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
      val p = player
      val items = mutableListOf(item(args.url))
      args.next?.let { items.add(item(it)) }
      p.setMediaItems(items, 0, (args.start * 1000).toLong())
      p.playWhenReady = !args.paused
      p.prepare()
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
        "volume" -> PlaybackService.setVolume(p, (args.value.toDoubleOrNull() ?: 100.0).toFloat() / 100f, null)
        "mute" -> PlaybackService.setVolume(p, null, args.value == "yes")
        "speed" -> p.playbackParameters = PlaybackParameters(args.value.toFloatOrNull() ?: 1f)
        "loop-file" -> p.repeatMode = if (args.value == "inf") Player.REPEAT_MODE_ONE else Player.REPEAT_MODE_OFF
        // mpv-only settings (EQ filter graph, ReplayGain, output device, gapless mode) have no
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
}
