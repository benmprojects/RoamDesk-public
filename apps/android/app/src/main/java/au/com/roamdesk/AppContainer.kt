package au.com.roamdesk

import android.app.Application
import android.net.ConnectivityManager
import android.net.Network
import au.com.roamdesk.data.OfflineQueue
import au.com.roamdesk.data.SettingsRepository
import au.com.roamdesk.data.net.HelperConnection
import au.com.roamdesk.drive.DriveStateMachine
import au.com.roamdesk.pairing.PairingRepository
import au.com.roamdesk.security.SecretCipher
import au.com.roamdesk.voice.Earcons
import au.com.roamdesk.voice.SpeechInput
import au.com.roamdesk.voice.SpeechOutput
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import okhttp3.OkHttpClient
import java.io.File
import java.util.concurrent.TimeUnit

/** Manual DI: one instance per process, created in [RoamDeskApp]. */
class AppContainer(app: Application) {
    val appScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    private val http = OkHttpClient.Builder()
        .dns(TimeoutDns())
        .connectTimeout(5, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS) // WebSocket: our own ping/watchdog handles dead links
        .writeTimeout(10, TimeUnit.SECONDS)
        .build()

    val settings = SettingsRepository(app)
    val queue = OfflineQueue(File(app.filesDir, "offline_queue.json"))
    private val cipher = SecretCipher()
    val pairing = PairingRepository(app, settings, cipher, queue, http)
    val connection = HelperConnection(http, settings, pairing::deviceSecret, appScope)
    val speechIn = SpeechInput(app)
    val speechOut = SpeechOutput(app)
    val earcons = Earcons()
    val files = au.com.roamdesk.files.FileInbox(app, http, connection, settings, appScope)
    val updater = au.com.roamdesk.update.AppUpdater(app, http, connection, settings, appScope)
    val drive = DriveStateMachine(appScope, connection, settings, queue, speechIn, speechOut, earcons, files = files)

    init {
        // Reconnect straight away when a network (e.g. mobile data after a tunnel) comes back.
        app.getSystemService(ConnectivityManager::class.java)?.registerDefaultNetworkCallback(
            object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(network: Network) = connection.reconnectNow()
            },
        )
    }
}
