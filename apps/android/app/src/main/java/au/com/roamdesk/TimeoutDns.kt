package au.com.roamdesk

import okhttp3.Dns
import java.io.IOException
import java.net.InetAddress
import java.net.UnknownHostException
import java.util.concurrent.ExecutionException
import java.util.concurrent.FutureTask
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException

/**
 * Name look-ups on Android can't be cancelled, so a stuck look-up of the PC's Tailscale name would leave every call
 * waiting long past its own timeout. This gives up after [limitMs] and says so.
 */
class TimeoutDns(private val limitMs: Long = 6_000) : Dns {
    override fun lookup(hostname: String): List<InetAddress> {
        val task = FutureTask { Dns.SYSTEM.lookup(hostname) }
        Thread(task, "dns-$hostname").apply { isDaemon = true }.start()
        try {
            return task.get(limitMs, TimeUnit.MILLISECONDS)
        } catch (e: TimeoutException) {
            task.cancel(true)
            throw UnknownHostException("looking up $hostname timed out")
        } catch (e: ExecutionException) {
            throw (e.cause as? IOException) ?: UnknownHostException("couldn't look up $hostname")
        }
    }
}
