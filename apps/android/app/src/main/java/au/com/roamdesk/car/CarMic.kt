package au.com.roamdesk.car

import android.os.ParcelFileDescriptor
import android.util.Log
import androidx.car.app.CarContext
import androidx.car.app.media.CarAudioRecord
import androidx.car.app.versioning.CarAppApiLevels
import au.com.roamdesk.voice.SpeechInput

/** The car's microphone via Android Auto, piped to the speech recogniser as 16 kHz mono PCM16. */
class CarMic(private val carContext: CarContext) : SpeechInput.ExternalMic {
    @Volatile private var running = false
    private var record: CarAudioRecord? = null

    override fun open(): ParcelFileDescriptor? {
        if (carContext.carAppApiLevel < CarAppApiLevels.LEVEL_5) return null
        close()
        return try {
            val rec = CarAudioRecord.create(carContext)
            val (read, write) = ParcelFileDescriptor.createPipe()
            rec.startRecording()
            record = rec
            running = true
            Thread {
                val buf = ByteArray(CarAudioRecord.AUDIO_CONTENT_BUFFER_SIZE)
                ParcelFileDescriptor.AutoCloseOutputStream(write).use { out ->
                    try {
                        while (running) {
                            val n = rec.read(buf, 0, buf.size)
                            if (n <= 0) break
                            out.write(buf, 0, n)
                        }
                    } catch (e: Exception) {
                        Log.d(TAG, "car mic stream ended: ${e.message}")
                    }
                }
            }.apply { name = "car-mic"; isDaemon = true }.start()
            read
        } catch (e: Exception) {
            Log.w(TAG, "car mic unavailable", e)
            null
        }
    }

    override fun close() {
        running = false
        record?.let { runCatching { it.stopRecording() } }
        record = null
    }

    private companion object { const val TAG = "CarMic" }
}
