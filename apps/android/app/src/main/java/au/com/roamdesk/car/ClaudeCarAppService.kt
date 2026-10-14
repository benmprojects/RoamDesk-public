package au.com.roamdesk.car

import android.content.Intent
import android.content.pm.ApplicationInfo
import androidx.car.app.CarAppService
import androidx.car.app.Screen
import androidx.car.app.Session
import androidx.car.app.validation.HostValidator
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import au.com.roamdesk.container

/** Android Auto entry point. Only Google's car hosts (Android Auto / Automotive) may bind. */
class ClaudeCarAppService : CarAppService() {
    // Debug builds accept any host (so Google's Desktop Head Unit works); release builds only Google's Android Auto and Automotive hosts.
    override fun createHostValidator(): HostValidator =
        if (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0) {
            HostValidator.ALLOW_ALL_HOSTS_VALIDATOR
        } else {
            HostValidator.Builder(applicationContext)
                .addAllowedHosts(androidx.car.app.R.array.hosts_allowlist_sample)
                .build()
        }

    override fun onCreateSession(): Session = ClaudeCarSession()
}

class ClaudeCarSession : Session() {
    override fun onCreateScreen(intent: Intent): Screen {
        val mic = CarMic(carContext)
        lifecycle.addObserver(object : DefaultLifecycleObserver {
            // Use the car's microphone while the car screen is up; back to the phone's afterwards.
            override fun onCreate(owner: LifecycleOwner) { carContext.container.speechIn.externalMic = mic }
            override fun onDestroy(owner: LifecycleOwner) {
                val s = carContext.container.speechIn
                if (s.externalMic === mic) s.externalMic = null
                mic.close()
            }
        })
        return DriveCarScreen(carContext)
    }
}
