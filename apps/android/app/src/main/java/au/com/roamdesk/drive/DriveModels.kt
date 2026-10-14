package au.com.roamdesk.drive

import au.com.roamdesk.protocol.HelperMessage
import au.com.roamdesk.protocol.CatalogItem
import au.com.roamdesk.protocol.Session

/** What the big ring shows. One word each. */
enum class DrivePhase(val label: String) {
    Idle("Ready"),
    Listening("Listening"),
    Thinking("Thinking"),
    Speaking("Speaking"),
    Confirming("Confirm"),
    Offline("Offline"),
}

enum class LinkStatus { NotPaired, Offline, Connecting, Online, Rejected }

data class ConversationItem(
    val id: Long,
    val kind: Kind,
    val text: String,
    val turnId: String? = null,
    val ts: Long = System.currentTimeMillis(),
    /** Set for [Kind.File]: a file Claude sent to the phone. */
    val file: HelperMessage.FileOffer? = null,
) {
    enum class Kind { User, Progress, Reply, System, Error, File }
}

data class PendingConfirm(val request: HelperMessage.ConfirmRequest, val deadlineMs: Long)

data class Notice(val id: Long, val text: String)

enum class EndReason { User, Idle, ServiceStopped, Unpaired }

data class DriveUiState(
    val paired: Boolean = false,
    val helperName: String = "",
    val link: LinkStatus = LinkStatus.NotPaired,
    val linkDetail: String = "",
    val driveActive: Boolean = false,
    val idleTimeoutMin: Int = 30,
    val phase: DrivePhase = DrivePhase.Offline,
    val partialTranscript: String = "",
    val lastHeard: String = "",
    val lastReply: String = "",
    val progressLabel: String? = null,
    val sessions: List<Session> = emptyList(),
    val activeSessionId: String? = null,
    val catalog: List<CatalogItem>? = null,
    val catalogLoading: Boolean = false,
    val pcBusy: Boolean = false,
    val pcQueued: Int = 0,
    val pcDisabled: Boolean = false,
    /** PC setting: run actions without asking for spoken confirmation. */
    val skipConfirmations: Boolean = false,
    /** PC setting: Claude keeps spoken updates plain (no file names or code). */
    val plainUpdates: Boolean = true,
    val confirm: PendingConfirm? = null,
    /** Text of a queued utterance currently being re-offered ("Still want me to …?"). */
    val queueQuestion: String? = null,
    val offlineQueued: Int = 0,
    val conversation: List<ConversationItem> = emptyList(),
    val notice: Notice? = null,
    val speechRate: Float = 1.0f,
    val voices: List<au.com.roamdesk.voice.SpeechOutput.VoiceOption> = emptyList(),
    /** Chosen voice; null = automatic. */
    val voiceName: String? = null,
) {
    val activeSession: Session? get() = sessions.firstOrNull { it.id == activeSessionId }
}
