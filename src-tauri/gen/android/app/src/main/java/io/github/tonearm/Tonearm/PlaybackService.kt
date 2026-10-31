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
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService

/**
 * Keeps playback alive in the background and provides the media notification, lock screen and
 * headset controls. Next/previous are handed to the app's queue rather than ExoPlayer's
 * two-item playlist.
 */
class PlaybackService : MediaSessionService() {
  private var session: MediaSession? = null

  companion object {
    private var exo: ExoPlayer? = null
    var onControl: ((String) -> Unit)? = null
    var volume = 1f
    var muted = false

    @OptIn(UnstableApi::class)
    fun player(context: Context): ExoPlayer =
      exo ?: ExoPlayer.Builder(context.applicationContext)
        .setAudioAttributes(
          AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MUSIC).build(),
          true,
        )
        .setHandleAudioBecomingNoisy(true)
        .setWakeMode(C.WAKE_MODE_NETWORK)
        .build()
        .also { exo = it }

    fun setVolume(p: Player, v: Float?, mute: Boolean?) {
      v?.let { volume = it.coerceIn(0f, 1f) }
      mute?.let { muted = it }
      p.volume = if (muted) 0f else volume
    }
  }

  @OptIn(UnstableApi::class)
  override fun onCreate() {
    super.onCreate()
    val forwarding = object : ForwardingPlayer(player(this)) {
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

      override fun seekToNext() { onControl?.invoke("next") }
      override fun seekToNextMediaItem() { onControl?.invoke("next") }
      override fun seekToPrevious() { onControl?.invoke("previous") }
      override fun seekToPreviousMediaItem() { onControl?.invoke("previous") }
      override fun stop() { onControl?.invoke("stop") }
    }
    val open = PendingIntent.getActivity(
      this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
    session = MediaSession.Builder(this, forwarding).setSessionActivity(open).build()
  }

  override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? = session

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
    exo = null
    super.onDestroy()
  }
}
