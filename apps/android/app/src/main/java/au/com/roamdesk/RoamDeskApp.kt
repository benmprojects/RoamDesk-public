package au.com.roamdesk

import android.app.Application
import android.content.Context

class RoamDeskApp : Application() {
    lateinit var container: AppContainer
        private set

    override fun onCreate() {
        super.onCreate()
        container = AppContainer(this)
        au.com.roamdesk.security.UnlockGate.watch(this)
    }
}

val Context.container: AppContainer get() = (applicationContext as RoamDeskApp).container
