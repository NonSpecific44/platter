package io.github.tonearm.Tonearm

import android.content.Context
import android.net.Uri
import android.os.Bundle
import androidx.annotation.OptIn
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.util.UnstableApi
import androidx.media3.session.LibraryResult
import androidx.media3.session.MediaConstants
import androidx.media3.session.MediaLibraryService.LibraryParams
import androidx.media3.session.MediaLibraryService.MediaLibrarySession
import androidx.media3.session.MediaSession
import com.google.common.collect.ImmutableList
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import com.google.common.util.concurrent.MoreExecutors
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.util.concurrent.Callable
import java.util.concurrent.Executors
import org.json.JSONArray
import org.json.JSONObject

/**
 * The browse tree Android Auto shows: Albums, Artists and Playlists tabs, read straight from the
 * Plex server so it works without the app's UI running. The app saves the server details through
 * [saveConfig] whenever they change.
 */
@OptIn(UnstableApi::class)
class AutoLibrary(private val context: Context) : MediaLibrarySession.Callback {
  private val pool = MoreExecutors.listeningDecorator(Executors.newFixedThreadPool(2))

  private fun <T> background(block: () -> T): ListenableFuture<T> = pool.submit(Callable { block() })

  companion object {
    private const val PREFS = "platter_auto"
    private const val ROOT = "root"
    const val EXTRA_JSON = "plex_json"

    fun saveConfig(context: Context, json: String) {
      context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString("config", json).apply()
    }

    /** The app's Made for you mixes (daylist, Suggestions): titles and track keys. */
    fun saveMixes(context: Context, json: String) {
      context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString("mixes", json).apply()
    }
  }

  private class Config(json: JSONObject) {
    val token: String = json.getString("token")
    val section: String = json.getString("section")
    val clientId: String = json.optString("clientId")
    val uris: List<String> = buildList {
      add(json.getString("uri"))
      val all = json.optJSONArray("uris") ?: JSONArray()
      for (i in 0 until all.length()) if (all.getString(i) !in this) add(all.getString(i))
    }
  }

  /** The mixes the app last made, in its order. Made in the app, which knows your listening. */
  private fun mixes(): List<JSONObject> {
    val raw = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("mixes", null) ?: return emptyList()
    val list = runCatching { JSONArray(raw) }.getOrNull() ?: return emptyList()
    return (0 until list.length()).map { list.getJSONObject(it) }.filter { (it.optJSONArray("keys")?.length() ?: 0) > 0 }
  }

  private fun config(): Config? =
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("config", null)?.let { Config(JSONObject(it)) }

  /** The address that last answered goes first next time. */
  private var workingUri: String? = null

  private fun get(cfg: Config, path: String): JSONObject {
    var failure: Exception? = null
    for (base in listOfNotNull(workingUri) + cfg.uris) {
      try {
        val conn = URL(base + path).openConnection() as HttpURLConnection
        conn.connectTimeout = 3000
        conn.readTimeout = 10000
        conn.setRequestProperty("Accept", "application/json")
        conn.setRequestProperty("X-Plex-Token", cfg.token)
        conn.setRequestProperty("X-Plex-Client-Identifier", cfg.clientId)
        conn.setRequestProperty("X-Plex-Product", "Platter")
        conn.setRequestProperty("X-Plex-Platform", "Android")
        if (conn.responseCode != 200) throw Exception("Plex returned ${conn.responseCode}")
        val body = conn.inputStream.bufferedReader().use { it.readText() }
        workingUri = base
        return JSONObject(body).getJSONObject("MediaContainer")
      } catch (e: Exception) {
        failure = e
      }
    }
    throw failure ?: Exception("No server address")
  }

  private fun metadata(c: JSONObject): List<JSONObject> {
    val list = c.optJSONArray("Metadata") ?: return emptyList()
    return (0 until list.length()).map { list.getJSONObject(it) }
  }

  private fun artwork(cfg: Config, thumb: String?): Uri? {
    if (thumb.isNullOrEmpty()) return null
    val base = workingUri ?: cfg.uris.first()
    val q = URLEncoder.encode(thumb, "UTF-8")
    return Uri.parse("$base/photo/:/transcode?width=512&height=512&minSize=1&upscale=1&url=$q&X-Plex-Token=${cfg.token}")
  }

  /** The app's drawn mix cover, made small: browse results cross a size-limited binder. */
  private fun smallCover(base64: String): ByteArray? {
    val bytes = android.util.Base64.decode(base64, android.util.Base64.DEFAULT)
    val full = android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.size) ?: return null
    val small = android.graphics.Bitmap.createScaledBitmap(full, 320, 320, true)
    val out = java.io.ByteArrayOutputStream()
    small.compress(android.graphics.Bitmap.CompressFormat.JPEG, 85, out)
    if (small !== full) small.recycle()
    full.recycle()
    return out.toByteArray()
  }

  private fun folder(id: String, title: String, subtitle: String? = null, art: Uri? = null, type: Int = MediaMetadata.MEDIA_TYPE_FOLDER_MIXED, playable: Boolean = false, artData: ByteArray? = null): MediaItem =
    MediaItem.Builder()
      .setMediaId(id)
      .setMediaMetadata(
        MediaMetadata.Builder()
          .setTitle(title)
          .setSubtitle(subtitle)
          .setArtworkUri(if (artData == null) art else null)
          .setArtworkData(artData, if (artData == null) null else MediaMetadata.PICTURE_TYPE_FRONT_COVER)
          .setIsBrowsable(true)
          .setIsPlayable(playable)
          .setMediaType(type)
          .build(),
      )
      .build()

  /** A playable track. `from` remembers its album or playlist, so tapping one plays the rest too. */
  private fun track(cfg: Config, m: JSONObject, from: String): MediaItem {
    val part = m.optJSONArray("Media")?.optJSONObject(0)?.optJSONArray("Part")?.optJSONObject(0)?.optString("key").orEmpty()
    val base = workingUri ?: cfg.uris.first()
    val thumb = m.optString("parentThumb").ifEmpty { m.optString("thumb") }
    val extras = Bundle().apply { putString(EXTRA_JSON, m.toString()) }
    return MediaItem.Builder()
      .setMediaId("track:${m.getString("ratingKey")}:$from")
      .setUri(if (part.isEmpty()) null else "$base$part?X-Plex-Token=${cfg.token}")
      .setMediaMetadata(
        MediaMetadata.Builder()
          .setTitle(m.optString("title"))
          .setArtist(m.optString("originalTitle").ifEmpty { m.optString("grandparentTitle") })
          .setAlbumTitle(m.optString("parentTitle"))
          .setArtworkUri(artwork(cfg, thumb))
          .setIsBrowsable(false)
          .setIsPlayable(true)
          .setMediaType(MediaMetadata.MEDIA_TYPE_MUSIC)
          .setExtras(extras)
          .build(),
      )
      .build()
  }

  private fun tracksOf(cfg: Config, id: String): List<MediaItem> {
    if (id.startsWith("mix:")) return mixTracks(cfg, id)
    val path = if (id.startsWith("playlist:")) "/playlists/${id.substringAfter(':')}/items" else "/library/metadata/${id.substringAfter(':')}/children"
    return metadata(get(cfg, path)).map { track(cfg, it, id) }
  }

  /** A mix's tracks, in the mix's order, fetched 50 at a time. */
  private fun mixTracks(cfg: Config, id: String): List<MediaItem> {
    val mix = mixes().firstOrNull { "mix:${it.getString("id")}" == id } ?: return emptyList()
    val keys = mix.getJSONArray("keys").let { k -> (0 until k.length()).map { k.getString(it) } }
    val found = keys.chunked(50).flatMap { metadata(get(cfg, "/library/metadata/${it.joinToString(",")}")) }
    val byKey = found.associateBy { it.getString("ratingKey") }
    return keys.mapNotNull { byKey[it] }.map { track(cfg, it, id) }
  }

  private fun children(cfg: Config, id: String, page: Int, pageSize: Int): List<MediaItem> {
    val paging = "X-Plex-Container-Start=${page * pageSize}&X-Plex-Container-Size=$pageSize"
    return when {
      id == "mixes" ->
        if (page > 0) emptyList()
        else mixes().map {
          val art = it.optString("art").takeIf { a -> a.isNotEmpty() }?.let { a -> runCatching { smallCover(a) }.getOrNull() }
          folder("mix:${it.getString("id")}", it.optString("label"), it.optString("title"), artwork(cfg, it.optString("thumb")), MediaMetadata.MEDIA_TYPE_PLAYLIST, playable = true, artData = art)
        }
      id == "albums" ->
        metadata(get(cfg, "/library/sections/${cfg.section}/all?type=9&sort=addedAt:desc&$paging")).map {
          folder("album:${it.getString("ratingKey")}", it.optString("title"), it.optString("parentTitle"), artwork(cfg, it.optString("thumb")), MediaMetadata.MEDIA_TYPE_ALBUM)
        }
      id == "artists" ->
        metadata(get(cfg, "/library/sections/${cfg.section}/all?type=8&sort=titleSort&$paging")).map {
          folder("artist:${it.getString("ratingKey")}", it.optString("title"), null, artwork(cfg, it.optString("thumb")), MediaMetadata.MEDIA_TYPE_ARTIST)
        }
      id == "playlists" ->
        metadata(get(cfg, "/playlists?playlistType=audio&$paging")).map {
          folder("playlist:${it.getString("ratingKey")}", it.optString("title"), "${it.optInt("leafCount")} tracks", artwork(cfg, it.optString("composite").ifEmpty { it.optString("thumb") }), MediaMetadata.MEDIA_TYPE_PLAYLIST)
        }
      id.startsWith("artist:") ->
        metadata(get(cfg, "/library/metadata/${id.substringAfter(':')}/children?excludeAllLeaves=1")).map {
          folder("album:${it.getString("ratingKey")}", it.optString("title"), it.optString("year"), artwork(cfg, it.optString("thumb")), MediaMetadata.MEDIA_TYPE_ALBUM)
        }
      id.startsWith("album:") || id.startsWith("playlist:") || id.startsWith("mix:") -> tracksOf(cfg, id)
      else -> emptyList()
    }
  }

  override fun onGetLibraryRoot(session: MediaLibrarySession, browser: MediaSession.ControllerInfo, params: LibraryParams?): ListenableFuture<LibraryResult<MediaItem>> {
    val extras = Bundle().apply {
      putInt(MediaConstants.EXTRAS_KEY_CONTENT_STYLE_BROWSABLE, MediaConstants.EXTRAS_VALUE_CONTENT_STYLE_GRID_ITEM)
      putInt(MediaConstants.EXTRAS_KEY_CONTENT_STYLE_PLAYABLE, MediaConstants.EXTRAS_VALUE_CONTENT_STYLE_LIST_ITEM)
    }
    return Futures.immediateFuture(LibraryResult.ofItem(folder(ROOT, "Platter"), LibraryParams.Builder().setExtras(extras).build()))
  }

  override fun onGetChildren(session: MediaLibrarySession, browser: MediaSession.ControllerInfo, parentId: String, page: Int, pageSize: Int, params: LibraryParams?): ListenableFuture<LibraryResult<ImmutableList<MediaItem>>> {
    if (parentId == ROOT) {
      // Android Auto shows the top level as tabs.
      val tabs = ImmutableList.builder<MediaItem>()
      if (mixes().isNotEmpty()) tabs.add(folder("mixes", "For you"))
      tabs.add(folder("albums", "Albums"), folder("artists", "Artists"), folder("playlists", "Playlists"))
      return Futures.immediateFuture(LibraryResult.ofItemList(if (page == 0) tabs.build() else ImmutableList.of(), params))
    }
    return background {
      val cfg = config() ?: return@background LibraryResult.ofError(LibraryResult.RESULT_ERROR_SESSION_AUTHENTICATION_EXPIRED)
      try {
        LibraryResult.ofItemList(ImmutableList.copyOf(children(cfg, parentId, page, pageSize)), params)
      } catch (e: Exception) {
        LibraryResult.ofError(LibraryResult.RESULT_ERROR_IO)
      }
    }
  }

  override fun onGetItem(session: MediaLibrarySession, browser: MediaSession.ControllerInfo, mediaId: String): ListenableFuture<LibraryResult<MediaItem>> =
    Futures.immediateFuture(LibraryResult.ofItem(folder(mediaId, mediaId), null))

  override fun onSearch(session: MediaLibrarySession, browser: MediaSession.ControllerInfo, query: String, params: LibraryParams?): ListenableFuture<LibraryResult<Void>> {
    session.notifySearchResultChanged(browser, query, 30, params)
    return Futures.immediateFuture(LibraryResult.ofVoid())
  }

  override fun onGetSearchResult(session: MediaLibrarySession, browser: MediaSession.ControllerInfo, query: String, page: Int, pageSize: Int, params: LibraryParams?): ListenableFuture<LibraryResult<ImmutableList<MediaItem>>> =
    background {
      val cfg = config() ?: return@background LibraryResult.ofError(LibraryResult.RESULT_ERROR_SESSION_AUTHENTICATION_EXPIRED)
      try {
        val q = URLEncoder.encode(query, "UTF-8")
        val found = metadata(get(cfg, "/library/sections/${cfg.section}/all?type=10&title=$q&X-Plex-Container-Size=$pageSize"))
        LibraryResult.ofItemList(ImmutableList.copyOf(found.map { track(cfg, it, "search:$query") }), params)
      } catch (e: Exception) {
        LibraryResult.ofError(LibraryResult.RESULT_ERROR_IO)
      }
    }

  /** Tapping a track plays its whole album, playlist or mix, starting there; tapping a mix plays it all. */
  override fun onSetMediaItems(mediaSession: MediaSession, controller: MediaSession.ControllerInfo, mediaItems: MutableList<MediaItem>, startIndex: Int, startPositionMs: Long): ListenableFuture<MediaSession.MediaItemsWithStartPosition> {
    // The app's own controller only binds the service; it never sets items through here.
    return background {
      PlaybackService.nativeQueue = true
      val cfg = config()
      val first = mediaItems.firstOrNull()
      val id = first?.mediaId.orEmpty()
      val from = if (id.startsWith("track:")) id.split(":", limit = 3).getOrNull(2).orEmpty() else id
      if (cfg != null && (from.startsWith("album:") || from.startsWith("playlist:") || from.startsWith("mix:"))) {
        try {
          val all = tracksOf(cfg, from)
          val at = all.indexOfFirst { it.mediaId == id }.coerceAtLeast(0)
          return@background MediaSession.MediaItemsWithStartPosition(all, at, startPositionMs)
        } catch (e: Exception) {
          // Fall through and play just what was asked for.
        }
      }
      MediaSession.MediaItemsWithStartPosition(mediaItems, startIndex, startPositionMs)
    }
  }

  override fun onAddMediaItems(mediaSession: MediaSession, controller: MediaSession.ControllerInfo, mediaItems: MutableList<MediaItem>): ListenableFuture<MutableList<MediaItem>> =
    Futures.immediateFuture(mediaItems.filter { it.localConfiguration != null }.toMutableList())
}
