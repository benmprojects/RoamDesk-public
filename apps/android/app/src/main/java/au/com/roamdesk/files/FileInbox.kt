package au.com.roamdesk.files

import android.content.ContentValues
import android.content.Context
import android.net.Uri
import android.os.Environment
import android.provider.MediaStore
import android.util.Log
import androidx.core.content.FileProvider
import au.com.roamdesk.data.SettingsRepository
import au.com.roamdesk.data.net.HelperConnection
import au.com.roamdesk.protocol.DEFAULT_PORT
import au.com.roamdesk.protocol.HelperMessage
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import okhttp3.HttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.util.concurrent.TimeUnit

sealed interface FileState {
    /** Offered but not downloaded (a large file, or not connected right now). */
    data object Waiting : FileState
    data class Downloading(val bytes: Long, val total: Long) : FileState
    data class Ready(val path: String) : FileState
    data class Failed(val message: String) : FileState
}

/** Files Claude sends to the phone: downloads them from the helper into app storage and hands them to other apps. */
class FileInbox(
    context: Context,
    http: OkHttpClient,
    private val connection: HelperConnection,
    private val settings: SettingsRepository,
    private val scope: CoroutineScope,
) {
    private val app = context.applicationContext
    private val client = http.newBuilder().readTimeout(30, TimeUnit.SECONDS).callTimeout(0, TimeUnit.MILLISECONDS).build()
    private val dir = File(app.filesDir, "received")
    private val offers = HashMap<String, HelperMessage.FileOffer>()
    private val jobs = HashMap<String, Job>()

    private val _states = MutableStateFlow<Map<String, FileState>>(emptyMap())
    val states: StateFlow<Map<String, FileState>> = _states.asStateFlow()

    init {
        scope.launch(Dispatchers.IO) { cleanOld() }
    }

    /** Called for every file frame, live or replayed. Safe to call twice for the same file. */
    fun receive(o: HelperMessage.FileOffer) {
        // The id becomes a folder name: anything but a plain token (e.g. "../datastore") is refused.
        if (!SAFE_ID.matches(o.fileId)) {
            Log.w(TAG, "ignored a file offer with an unsafe id")
            return
        }
        if (offers.putIfAbsent(o.fileId, o) != null) return
        val have = localFile(o)
        when {
            have != null -> set(o.fileId, FileState.Ready(have.path))
            o.expiresAt in 1 until System.currentTimeMillis() -> set(o.fileId, FileState.Failed("This file has expired on your PC."))
            o.size <= AUTO_DOWNLOAD_MAX_BYTES -> download(o.fileId)
            else -> set(o.fileId, FileState.Waiting)
        }
    }

    fun download(fileId: String) {
        val o = offers[fileId] ?: return
        if (jobs[fileId]?.isActive == true) return
        jobs[fileId] = scope.launch(Dispatchers.IO) {
            val st = connection.state.value as? HelperConnection.State.Connected
            if (st == null) {
                set(fileId, FileState.Failed("Not connected to your PC. Try again when it's online."))
                return@launch
            }
            set(fileId, FileState.Downloading(0, o.size))
            try {
                // Same route as the live connection: https on the encrypted link, http on a plain Tailscale address.
                val url = st.endpoint.http()
                    .addPathSegment("file").addPathSegment(o.fileId).addQueryParameter("a", o.access).build()
                val target = File(dir, "${o.fileId}/${safeName(o.name)}")
                if (!target.canonicalPath.startsWith(dir.canonicalPath + File.separator)) throw java.io.IOException("Unsafe file name.")
                target.parentFile?.mkdirs()
                val part = File(target.parentFile, target.name + ".part")
                client.newCall(Request.Builder().url(url).build()).execute().use { resp ->
                    if (!resp.isSuccessful) {
                        set(fileId, FileState.Failed(if (resp.code == 404) "Your PC no longer has this file." else "Your PC answered ${resp.code}."))
                        return@launch
                    }
                    val body = resp.body ?: run { set(fileId, FileState.Failed("Empty answer from your PC.")); return@launch }
                    val total = body.contentLength().takeIf { it > 0 } ?: o.size
                    // Never write more than the PC said it was sending, and never more than the PC's own limit.
                    val limit = if (o.size > 0) minOf(o.size, MAX_DOWNLOAD_BYTES) else MAX_DOWNLOAD_BYTES
                    if (total > limit) throw java.io.IOException("the file is bigger than expected")
                    var done = 0L
                    var lastReport = 0L
                    body.byteStream().use { input ->
                        part.outputStream().use { out ->
                            val buf = ByteArray(64 * 1024)
                            while (true) {
                                val n = input.read(buf)
                                if (n < 0) break
                                done += n
                                if (done > limit) throw java.io.IOException("the file is bigger than expected")
                                out.write(buf, 0, n)
                                ensureActive()
                                val now = System.currentTimeMillis()
                                if (now - lastReport > 120) { lastReport = now; set(fileId, FileState.Downloading(done, total)) }
                            }
                        }
                    }
                }
                if (target.exists()) target.delete()
                if (!part.renameTo(target)) throw java.io.IOException("Couldn't save the file.")
                set(fileId, FileState.Ready(target.path))
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e
            } catch (e: Exception) {
                Log.w(TAG, "download failed", e)
                set(fileId, FileState.Failed("Download failed (${e.message ?: e.javaClass.simpleName}). Tap Retry."))
            }
        }
    }

    fun offer(fileId: String): HelperMessage.FileOffer? = offers[fileId]

    private fun readyFile(fileId: String): File? = (states.value[fileId] as? FileState.Ready)?.path?.let(::File)?.takeIf { it.exists() }

    /** A content:// address other apps can read, plus the file's type. */
    fun shareUri(fileId: String): Pair<Uri, String>? {
        val f = readyFile(fileId) ?: return null
        val mime = safeMime(offers[fileId]?.mime, f.name)
        return FileProvider.getUriForFile(app, "${app.packageName}.files", f) to mime
    }

    /** Copies the file into the phone's Downloads folder. Returns a message for the user. */
    fun saveToDownloads(fileId: String): String {
        val f = readyFile(fileId) ?: return "That file isn't downloaded yet."
        val o = offers[fileId] ?: return "That file isn't known any more."
        return try {
            val values = ContentValues().apply {
                put(MediaStore.Downloads.DISPLAY_NAME, safeName(o.name))
                put(MediaStore.Downloads.MIME_TYPE, safeMime(o.mime, o.name))
                put(MediaStore.Downloads.RELATIVE_PATH, "${Environment.DIRECTORY_DOWNLOADS}/Roam Desk")
                put(MediaStore.Downloads.IS_PENDING, 1)
            }
            val resolver = app.contentResolver
            val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: return "Couldn't create the file in Downloads."
            resolver.openOutputStream(uri)?.use { out -> f.inputStream().use { it.copyTo(out) } }
            values.clear()
            values.put(MediaStore.Downloads.IS_PENDING, 0)
            resolver.update(uri, values, null, null)
            "Saved to Downloads › Roam Desk."
        } catch (e: Exception) {
            Log.w(TAG, "save failed", e)
            "Couldn't save it (${e.message ?: e.javaClass.simpleName})."
        }
    }

    private fun localFile(o: HelperMessage.FileOffer): File? =
        File(dir, "${o.fileId}/${safeName(o.name)}").takeIf { it.isFile && (o.size <= 0 || it.length() == o.size) }

    private fun set(id: String, s: FileState) = _states.update { it + (id to s) }

    private fun cleanOld() {
        val cutoff = System.currentTimeMillis() - 7L * 24 * 60 * 60 * 1000
        dir.listFiles()?.filter { it.isDirectory && it.lastModified() < cutoff }?.forEach { it.deleteRecursively() }
    }

    companion object {
        private const val TAG = "FileInbox"
        const val AUTO_DOWNLOAD_MAX_BYTES = 25L * 1024 * 1024
        /** The PC refuses anything over 200 MB; a little headroom for rounding. */
        const val MAX_DOWNLOAD_BYTES = 210L * 1024 * 1024
        private val SAFE_ID = Regex("^[A-Za-z0-9_-]{1,64}$")
        private const val APK_MIME = "application/vnd.android.package-archive"

        fun safeName(name: String): String =
            name.replace(Regex("[\\\\/:*?\"<>|\\u0000-\\u001f]"), "_").trim().take(120)
                .let { if (it.isBlank() || it.all { c -> c == '.' }) "file" else it }

        /** Builds that can't install apps (the Play build) never hand a received file to the package installer. */
        fun safeMime(mime: String?, name: String): String {
            val m = mime?.takeIf { it.isNotBlank() } ?: "application/octet-stream"
            val isApk = m.equals(APK_MIME, ignoreCase = true) || name.endsWith(".apk", ignoreCase = true)
            return if (isApk && !au.com.roamdesk.BuildConfig.SELF_UPDATE) "application/octet-stream" else m
        }
    }
}
