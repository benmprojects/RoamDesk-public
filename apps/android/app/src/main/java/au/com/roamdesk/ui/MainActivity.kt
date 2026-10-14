package au.com.roamdesk.ui

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.view.WindowManager
import android.content.Intent
import androidx.core.net.toUri
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.lifecycleScope
import au.com.roamdesk.container
import au.com.roamdesk.data.Pairing
import au.com.roamdesk.drive.EndReason
import au.com.roamdesk.pairing.PairResult
import au.com.roamdesk.pairing.QrScanner
import au.com.roamdesk.protocol.PhoneMessage
import au.com.roamdesk.security.BiometricGate
import au.com.roamdesk.service.DriveService
import au.com.roamdesk.ui.theme.RoamDeskTheme
import android.widget.Toast
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch

/** FragmentActivity (not ComponentActivity) because BiometricPrompt needs it. */
class MainActivity : FragmentActivity(), AppActions {

    private var permissions by mutableStateOf(PermissionState(mic = false, notifications = false))
    private var startDriveAfterPermissions = false

    private val permissionLauncher = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        refreshPermissions()
        if (startDriveAfterPermissions) {
            startDriveAfterPermissions = false
            if (permissions.mic) unlockAndStartDrive()
            else toast("Roam Desk needs the microphone for Drive sessions.")
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        refreshPermissions()
        val c = container
        // Keep the screen on while the app is in the foreground, if enabled in Settings.
        // The window flag only applies while this activity is visible.
        lifecycleScope.launch {
            c.settings.prefs.map { it.keepScreenOn }.distinctUntilChanged().collect { on ->
                if (on) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            }
        }
        val pairingLoad = c.settings.pairing.map { PairingLoad(true, it) }
        setContent {
            val state by c.drive.state.collectAsStateWithLifecycle()
            val downloads by c.files.states.collectAsStateWithLifecycle()
            val update by c.updater.state.collectAsStateWithLifecycle()
            val updateBannerHidden by c.updater.bannerHidden.collectAsStateWithLifecycle()
            val prefs by c.settings.prefs.collectAsStateWithLifecycle(initialValue = null)
            val pairingState by pairingLoad.collectAsStateWithLifecycle(initialValue = PairingLoad(false, null))
            RoamDeskTheme {
                AppRoot(
                    state = state,
                    prefs = prefs,
                    pairing = pairingState.pairing,
                    pairingLoaded = pairingState.loaded,
                    permissions = permissions,
                    downloads = downloads,
                    update = update,
                    updateBannerHidden = updateBannerHidden,
                    actions = this,
                )
            }
        }
    }

    private data class PairingLoad(val loaded: Boolean, val pairing: Pairing?)

    override fun onStart() {
        super.onStart()
        container.connection.acquire(HOLD_UI)
    }

    override fun onResume() {
        super.onResume()
        refreshPermissions()
        au.com.roamdesk.security.UnlockGate.noteIfUnlocked(this)
    }

    override fun onStop() {
        container.connection.release(HOLD_UI)
        super.onStop()
    }

    private fun refreshPermissions() {
        val mic = granted(Manifest.permission.RECORD_AUDIO)
        val notif = Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU || granted(Manifest.permission.POST_NOTIFICATIONS)
        val battery = getSystemService(PowerManager::class.java)?.isIgnoringBatteryOptimizations(packageName) ?: true
        permissions = PermissionState(mic, notif, battery)
    }

    private fun granted(p: String) = ContextCompat.checkSelfPermission(this, p) == PackageManager.PERMISSION_GRANTED

    private fun neededPermissions(): Array<String> = buildList {
        if (!granted(Manifest.permission.RECORD_AUDIO)) add(Manifest.permission.RECORD_AUDIO)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && !granted(Manifest.permission.POST_NOTIFICATIONS)) {
            add(Manifest.permission.POST_NOTIFICATIONS)
        }
    }.toTypedArray()

    private fun toast(text: String) = Toast.makeText(this, text, Toast.LENGTH_LONG).show()

    // ------------------------------------------------------------------ AppActions

    override fun startDrive() {
        if (container.drive.isDriveActive) return
        val needed = neededPermissions()
        if (needed.isNotEmpty()) {
            startDriveAfterPermissions = true
            permissionLauncher.launch(needed)
            return
        }
        unlockAndStartDrive()
    }

    private fun unlockAndStartDrive() {
        if (!container.speechIn.isAvailable) {
            toast("No speech recogniser on this phone. Install or enable Google speech services.")
            return
        }
        BiometricGate.authenticate(
            this,
            onSuccess = {
                container.drive.startDrive()
                try {
                    DriveService.start(this)
                } catch (e: Exception) {
                    container.drive.endDrive(EndReason.ServiceStopped)
                    toast("Couldn't start the Drive session: ${e.message}")
                }
            },
            onFailure = { reason -> reason?.let(::toast) },
        )
    }

    override fun endDrive() = container.drive.endDrive(EndReason.User)
    override fun talk() = container.drive.onTalk()
    override fun kill() = container.drive.killEverything()
    override fun cancelTurn() = container.drive.cancelCurrentTurn()
    override fun confirm(approve: Boolean) = container.drive.onConfirmButton(approve)
    override fun sendTyped(text: String) = container.drive.submitUtterance(text, PhoneMessage.SOURCE_TYPED)
    override fun selectSession(id: String) { container.drive.selectSession(id) }
    override fun newSession(name: String) { container.drive.newSession(name) }
    override fun resetSession(id: String?) { container.drive.resetSession(id) }
    override fun loadCatalog() { container.drive.loadCatalog() }
    override fun attachSession(claudeSessionId: String) { container.drive.attachSession(claudeSessionId) }
    override fun releaseSession(sessionId: String) { container.drive.releaseSession(sessionId) }

    override fun loadHistory() = container.drive.loadHistory(manual = true)
    override fun updateHelper() {
        if (!container.connection.send(au.com.roamdesk.protocol.PhoneMessage.HelperUpdate)) toast("Not connected to your PC.")
    }
    override fun checkForUpdate() = container.updater.check()
    override fun downloadUpdate() = container.updater.download()
    override fun installUpdate() { container.updater.install(this)?.let(::toast) }
    override fun dismissUpdate() = container.updater.dismiss()

    override fun downloadFile(fileId: String) = container.files.download(fileId)

    override fun openFile(fileId: String) {
        val (uri, mime) = container.files.shareUri(fileId) ?: return toast("That file isn't downloaded yet.")
        val view = Intent(Intent.ACTION_VIEW).setDataAndType(uri, mime).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        try {
            startActivity(view)
        } catch (e: android.content.ActivityNotFoundException) {
            toast("No app on this phone opens this kind of file. Use Share or Save.")
        }
    }

    override fun shareFile(fileId: String) {
        val (uri, mime) = container.files.shareUri(fileId) ?: return toast("That file isn't downloaded yet.")
        val send = Intent(Intent.ACTION_SEND).setType(mime).putExtra(Intent.EXTRA_STREAM, uri)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        send.clipData = android.content.ClipData.newRawUri("", uri)
        startActivity(Intent.createChooser(send, "Share"))
    }

    override fun saveFile(fileId: String) {
        lifecycleScope.launch {
            val message = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) { container.files.saveToDownloads(fileId) }
            toast(message)
        }
    }
    override fun setSkipConfirmations(on: Boolean) = container.drive.setSkipConfirmations(on)
    override fun setPlainUpdates(on: Boolean) = container.drive.setPlainUpdates(on)

    override suspend fun scanQr(): String? = QrScanner.scan(this)
    override suspend fun pair(json: String): PairResult = container.pairing.pair(json)

    override fun unpair() {
        container.drive.endDrive(EndReason.Unpaired)
        lifecycleScope.launch { container.pairing.unpair() }
    }

    override fun setSpeechRate(rate: Float) { lifecycleScope.launch { container.settings.setSpeechRate(rate) } }
    override fun setIdleTimeout(min: Int) { lifecycleScope.launch { container.settings.setIdleTimeout(min) } }
    override fun setKeepScreenOn(on: Boolean) { lifecycleScope.launch { container.settings.setKeepScreenOn(on) } }
    override fun testVoice() = container.drive.testVoice()
    override fun loadVoices() = container.drive.loadVoices()
    override fun setVoice(name: String?) {
        container.drive.previewVoice(name)
        lifecycleScope.launch { container.settings.setVoiceName(name) }
    }
    override fun openSpeechSettings() {
        runCatching { startActivity(Intent("com.android.settings.TTS_SETTINGS")) }
            .onFailure { toast("Open Settings › General management › Text-to-speech.") }
    }
    override fun reconnect() = container.connection.reconnectNow()

    override fun requestPermissions() {
        val needed = neededPermissions()
        if (needed.isNotEmpty()) permissionLauncher.launch(needed)
    }

    /** Samsung (and other OEM) battery management can freeze the Drive service; ask to be exempt. */
    @android.annotation.SuppressLint("BatteryLife")
    override fun requestBatteryExemption() {
        val direct = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, "package:$packageName".toUri())
        try {
            startActivity(direct)
        } catch (e: Exception) {
            runCatching { startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)) }
                .onFailure { toast("Open Settings › Apps › Roam Desk › Battery and choose Unrestricted.") }
        }
    }

    override fun finishOnboarding() { lifecycleScope.launch { container.settings.setOnboarded(true) } }
    override fun consumeNotice(id: Long) = container.drive.consumeNotice(id)

    private companion object {
        const val HOLD_UI = "ui"
    }
}
