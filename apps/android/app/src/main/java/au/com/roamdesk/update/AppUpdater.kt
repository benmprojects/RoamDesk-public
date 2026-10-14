package au.com.roamdesk.update

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import android.util.Log
import androidx.core.content.FileProvider
import au.com.roamdesk.BuildConfig
import au.com.roamdesk.data.SettingsRepository
import au.com.roamdesk.data.net.HelperConnection
import au.com.roamdesk.protocol.DEFAULT_PORT
import au.com.roamdesk.protocol.HelperMessage
import au.com.roamdesk.protocol.PhoneMessage
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import okhttp3.HttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.util.concurrent.TimeUnit

sealed interface UpdateState {
    data object UpToDate : UpdateState
    data object Checking : UpdateState
    data class Available(val versionName: String, val size: Long) : UpdateState
    data class Downloading(val bytes: Long, val total: Long) : UpdateState
    data class Ready(val versionName: String) : UpdateState
    data class Failed(val message: String) : UpdateState
}

/** Keeps the app up to date from the paired PC: the helper offers its newest build, we download and hand it to Android's installer. */
class AppUpdater(
    context: Context,
    http: OkHttpClient,
    private val connection: HelperConnection,
    private val settings: SettingsRepository,
    private val scope: CoroutineScope,
) {
    private val app = context.applicationContext
    private val client = http.newBuilder().readTimeout(30, TimeUnit.SECONDS).callTimeout(0, TimeUnit.MILLISECONDS).build()
    private val dir = File(app.cacheDir, "updates")
    private var offer: HelperMessage.AppUpdate? = null
    private var job: Job? = null

    private val _state = MutableStateFlow<UpdateState>(UpdateState.UpToDate)
    val state: StateFlow<UpdateState> = _state.asStateFlow()

    /** Banner dismissed for the version on offer (comes back when a newer one appears). */
    private var dismissedCode = 0L
    private val _bannerHidden = MutableStateFlow(false)
    val bannerHidden: StateFlow<Boolean> = _bannerHidden.asStateFlow()

    val currentVersion: String get() = BuildConfig.VERSION_NAME

    init {
        // The Google Play build never updates itself: Play does that, and Play forbids apps installing their own updates.
        if (BuildConfig.SELF_UPDATE) {
            scope.launch(Dispatchers.IO) { dir.listFiles()?.forEach { it.delete() } } // installed or stale downloads
            watchOffers()
        }
    }

    private fun watchOffers() {
        scope.launch {
            connection.frames.collect { f ->
                val m = f.message
                if (m is HelperMessage.AppUpdate) onOffer(m)
                else if (m is HelperMessage.HelperError && m.code == "no_build" && _state.value == UpdateState.Checking) {
                    _state.value = UpdateState.Failed("Your PC doesn't have an app build to offer.")
                }
            }
        }
    }

    private fun onOffer(o: HelperMessage.AppUpdate) {
        offer = o
        _bannerHidden.value = o.versionCode <= dismissedCode
        if (job?.isActive == true) return
        _state.value = if (o.versionCode > BuildConfig.VERSION_CODE) UpdateState.Available(o.versionName, o.size) else UpdateState.UpToDate
    }

    fun check() {
        if (!BuildConfig.SELF_UPDATE) return
        if (connection.send(PhoneMessage.AppCheck)) _state.value = UpdateState.Checking
        else _state.value = UpdateState.Failed("Not connected to your PC.")
    }

    fun dismiss() {
        dismissedCode = offer?.versionCode ?: 0L
        _bannerHidden.value = true
    }

    fun download() {
        val o = offer ?: return
        if (job?.isActive == true) return
        job = scope.launch(Dispatchers.IO) {
            val st = connection.state.value as? HelperConnection.State.Connected
            if (st == null) {
                _state.value = UpdateState.Failed("Not connected to your PC.")
                return@launch
            }
            _state.value = UpdateState.Downloading(0, o.size)
            try {
                dir.mkdirs()
                val target = File(dir, "claude-anywhere-${o.versionCode}.apk")
                val part = File(dir, target.name + ".part")
                val url = st.endpoint.http()
                    .addPathSegment("app").addPathSegment("apk").addQueryParameter("a", o.access).build()
                client.newCall(Request.Builder().url(url).build()).execute().use { resp ->
                    if (!resp.isSuccessful) {
                        _state.value = UpdateState.Failed(if (resp.code == 404) "Your PC's helper restarted. Tap Check for updates." else "Your PC answered ${resp.code}.")
                        return@launch
                    }
                    val body = resp.body ?: run { _state.value = UpdateState.Failed("Empty download."); return@launch }
                    val total = body.contentLength().takeIf { it > 0 } ?: o.size
                    var done = 0L
                    var last = 0L
                    body.byteStream().use { input ->
                        part.outputStream().use { out ->
                            val buf = ByteArray(64 * 1024)
                            while (true) {
                                val n = input.read(buf)
                                if (n < 0) break
                                done += n
                                if (done > MAX_APK_BYTES) throw java.io.IOException("the download is far bigger than an app build")
                                out.write(buf, 0, n)
                                ensureActive()
                                val now = System.currentTimeMillis()
                                if (now - last > 150) { last = now; _state.value = UpdateState.Downloading(done, total) }
                            }
                        }
                    }
                }
                verify(part)?.let { problem ->
                    part.delete()
                    _state.value = UpdateState.Failed(problem)
                    return@launch
                }
                if (target.exists()) target.delete()
                if (!part.renameTo(target)) throw java.io.IOException("Couldn't save the update.")
                _state.value = UpdateState.Ready(o.versionName)
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e
            } catch (e: Exception) {
                Log.w(TAG, "update download failed", e)
                _state.value = UpdateState.Failed("Download failed (${e.message ?: e.javaClass.simpleName}).")
            }
        }
    }

    /** Opens Android's installer for the downloaded build, or the permission screen the first time. Returns a message to show, if any. */
    fun install(activity: android.app.Activity): String? {
        val o = offer ?: return "No update downloaded."
        val file = File(dir, "claude-anywhere-${o.versionCode}.apk")
        if (!file.exists()) return "Download the update first."
        if (!app.packageManager.canRequestPackageInstalls()) {
            activity.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${app.packageName}")))
            return "Allow Roam Desk to install updates, then tap Install again."
        }
        val uri = FileProvider.getUriForFile(app, "${app.packageName}.files", file)
        activity.startActivity(
            Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive")
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION),
        )
        return null
    }

    /**
     * Checks the downloaded APK is this app, signed with the same key, and newer, before Android's installer ever sees it.
     * Returns a message for the user if it isn't, or null if it's fine.
     */
    private fun verify(apk: File): String? {
        val pm = app.packageManager
        val flags = android.content.pm.PackageManager.GET_SIGNING_CERTIFICATES
        val archive = pm.getPackageArchiveInfo(apk.path, flags) ?: return "The download isn't a valid app build."
        if (archive.packageName != app.packageName) return "The download is a different app, so it wasn't installed."
        if (archive.longVersionCode <= BuildConfig.VERSION_CODE) return "The download isn't newer than this version."
        val installed = pm.getPackageInfo(app.packageName, flags)
        fun signers(info: android.content.pm.PackageInfo) =
            info.signingInfo?.let { if (it.hasMultipleSigners()) it.apkContentsSigners else it.signingCertificateHistory }
                ?.map { it.toByteArray().contentHashCode() to it.toCharsString() }?.toSet().orEmpty()
        val want = signers(installed)
        val got = signers(archive)
        if (want.isEmpty() || got.isEmpty() || got.intersect(want).isEmpty()) return "The download isn't signed like this app, so it wasn't installed."
        return null
    }

    private companion object {
        const val TAG = "AppUpdater"
        const val MAX_APK_BYTES = 200L * 1024 * 1024
    }
}
