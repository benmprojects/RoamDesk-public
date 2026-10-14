package au.com.roamdesk.security

import android.app.KeyguardManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter

/**
 * Starting Drive from the car (or approving there) works with the phone locked, but only within a while of the
 * owner last unlocking it. A phone that's been lost or stolen, and stayed locked, can't be used to drive the PC.
 */
object UnlockGate {
    const val WINDOW_HOURS = 12
    private const val WINDOW_MS = WINDOW_HOURS * 60L * 60 * 1000
    private const val PREFS = "unlock_gate"
    private const val KEY = "last_unlock_at"

    const val LOCKED_MESSAGE = "Unlock your phone once to use Roam Desk in the car. " +
        "For safety it only works within $WINDOW_HOURS hours of your phone last being unlocked."

    /** Call from Application.onCreate: records each unlock while the app is running. */
    fun watch(context: Context) {
        val app = context.applicationContext
        noteIfUnlocked(app)
        app.registerReceiver(
            object : BroadcastReceiver() {
                override fun onReceive(c: Context, i: Intent) = note(app)
            },
            IntentFilter(Intent.ACTION_USER_PRESENT),
        )
    }

    /** Records an unlock if the phone isn't locked right now (e.g. the app was just opened). */
    fun noteIfUnlocked(context: Context) {
        val km = context.getSystemService(KeyguardManager::class.java)
        if (km != null && !km.isDeviceLocked) note(context)
    }

    private fun note(context: Context) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putLong(KEY, System.currentTimeMillis()).apply()
    }

    /** True if the phone is unlocked now, or was unlocked within the window. */
    fun allowed(context: Context): Boolean {
        val km = context.getSystemService(KeyguardManager::class.java)
        if (km != null && !km.isDeviceLocked) {
            note(context)
            return true
        }
        val last = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getLong(KEY, 0L)
        val age = System.currentTimeMillis() - last
        return last > 0 && age in 0..WINDOW_MS
    }
}
