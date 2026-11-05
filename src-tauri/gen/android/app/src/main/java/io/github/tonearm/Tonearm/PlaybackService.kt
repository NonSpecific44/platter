package io.github.tonearm.Tonearm

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.annotation.OptIn
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.ForwardingPlayer
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.session.MediaLibraryService
import androidx.media3.session.MediaSession

/**
 * Keeps playback alive in the background and provides the media notification, lock screen,
 * headset and steering-wheel controls, and (through the media library) Android Auto.
 *
 * Normally the queue lives in the app, so next/previous are handed to it. When Android Auto starts
 * playback with no app running ([nativeQueue]), ExoPlayer holds the whole queue itself.
 */
class PlaybackService : MediaLibraryService() {
  private var session: MediaLibrarySession? = null

  companion object {
    private var exo: ExoPlayer? = null
    private var instance: PlaybackService? = null
    var onControl: ((String) -> Unit)? = null
    var nativeQueue = false
    var volume = 1f
    var muted = false

    private val attributes =
      AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MUSIC).build()

    @OptIn(UnstableApi::class)
    fun newPlayer(context: Context, handleFocus: Boolean = true): ExoPlayer =
      ExoPlayer.Builder(context.applicationContext)
        .setAudioAttributes(attributes, handleFocus)
        .setHandleAudioBecomingNoisy(true)
        .setWakeMode(C.WAKE_MODE_NETWORK)
        .build()

    fun player(context: Context): ExoPlayer = exo ?: newPlayer(context).also { exo = it }

    /** After a crossfade: [next] becomes the player everything else talks to. */
    fun swapPlayer(next: ExoPlayer) {
      exo = next
      instance?.session?.player = instance!!.wrap(next)
    }

    /** The incoming deck can take audio focus once the outgoing one has let go of it. */
    fun takeFocus(p: ExoPlayer) {
      p.setAudioAttributes(attributes, true)
    }
  }

  @OptIn(UnstableApi::class)
  private fun wrap(p: Player): Player =
    object : ForwardingPlayer(p) {
      override fun getAvailableCommands(): Player.Commands =
        super.getAvailableCommands().buildUpon()
          .add(Player.COMMAND_SEEK_TO_NEXT)
          .add(Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM)
          .add(Player.COMMAND_SEEK_TO_PREVIOUS)
          .add(Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM)
          .build()

      override fun isCommandAvailable(command: Int): Boolean =
        when (command) {
          Player.COMMAND_SEEK_TO_NEXT, Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM,
          Player.COMMAND_SEEK_TO_PREVIOUS, Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM -> true
          else -> super.isCommandAvailable(command)
        }

      override fun seekToNext() { if (nativeQueue) super.seekToNext() else onControl?.invoke("next") }
      override fun seekToNextMediaItem() { if (nativeQueue) super.seekToNextMediaItem() else onControl?.invoke("next") }
      override fun seekToPrevious() { if (nativeQueue) super.seekToPrevious() else onControl?.invoke("previous") }
      override fun seekToPreviousMediaItem() { if (nativeQueue) super.seekToPreviousMediaItem() else onControl?.invoke("previous") }
      override fun stop() { if (nativeQueue) super.stop() else onControl?.invoke("stop") }
    }

  @OptIn(UnstableApi::class)
  override fun onCreate() {
    super.onCreate()
    instance = this
    val open = PendingIntent.getActivity(
      this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
    session = MediaLibrarySession.Builder(this, wrap(player(this)), AutoLibrary(this)).setSessionActivity(open).build()
  }

  override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaLibrarySession? = session

  override fun onTaskRemoved(rootIntent: Intent?) {
    val p = session?.player
    if (p == null || !p.playWhenReady || p.mediaItemCount == 0) stopSelf()
  }

  override fun onDestroy() {
    session?.run {
      player.release()
      release()
    }
    session = null
    instance = null
    exo = null
    super.onDestroy()
  }
}
