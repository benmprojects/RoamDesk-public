package au.com.roamdesk.data

import au.com.roamdesk.protocol.Wire
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import java.io.File

@Serializable
data class QueuedUtterance(
    val id: String,
    val text: String,
    val source: String,
    val queuedAt: Long,
)

/**
 * Utterances made while the PC was unreachable. Kept on disk for [ttlMs] (30 min), then dropped.
 * Confirmations are never queued here (PROTOCOL.md §Spoken confirmation flow, step 5).
 */
class OfflineQueue(
    private val file: File,
    private val ttlMs: Long = 30 * 60_000L,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    private val mutex = Mutex()
    private var items: MutableList<QueuedUtterance>? = null
    private val serializer = ListSerializer(QueuedUtterance.serializer())

    private val _count = MutableStateFlow(0)
    val count: StateFlow<Int> = _count.asStateFlow()

    private suspend fun loaded(): MutableList<QueuedUtterance> {
        items?.let { return it }
        val list = withContext(Dispatchers.IO) {
            runCatching { Wire.json.decodeFromString(serializer, file.readText()) }.getOrDefault(emptyList())
        }.toMutableList()
        items = list
        return list
    }

    private suspend fun save(list: List<QueuedUtterance>) {
        _count.value = list.size
        withContext(Dispatchers.IO) {
            file.parentFile?.mkdirs()
            val tmp = File(file.parentFile, file.name + ".tmp")
            tmp.writeText(Wire.json.encodeToString(serializer, list))
            if (!tmp.renameTo(file)) {
                file.delete(); tmp.renameTo(file)
            }
        }
    }

    suspend fun add(item: QueuedUtterance) = mutex.withLock {
        val list = loaded()
        list += item
        purgeLocked(list)
        save(list)
    }

    /** Non-expired items, oldest first. Expired ones are removed. */
    suspend fun pending(): List<QueuedUtterance> = mutex.withLock {
        val list = loaded()
        if (purgeLocked(list)) save(list) else _count.value = list.size
        list.toList()
    }

    suspend fun remove(id: String) = mutex.withLock {
        val list = loaded()
        if (list.removeAll { it.id == id }) save(list)
    }

    suspend fun clear() = mutex.withLock {
        val list = loaded()
        list.clear()
        save(list)
    }

    private fun purgeLocked(list: MutableList<QueuedUtterance>): Boolean {
        val now = clock()
        return list.removeAll { now - it.queuedAt > ttlMs }
    }
}
