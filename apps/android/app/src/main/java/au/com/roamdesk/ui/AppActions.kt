package au.com.roamdesk.ui

import au.com.roamdesk.pairing.PairResult

/** Everything the UI can ask for. Implemented by [MainActivity] (which owns biometrics, permissions and the scanner). */
interface AppActions {
    fun startDrive()
    fun endDrive()
    fun talk()
    fun kill()
    fun cancelTurn()
    fun confirm(approve: Boolean)
    fun sendTyped(text: String)
    fun selectSession(id: String)
    fun newSession(name: String)
    fun resetSession(id: String?)
    fun loadCatalog()
    fun attachSession(claudeSessionId: String)
    fun loadHistory()
    fun updateHelper()
    fun checkForUpdate()
    fun downloadUpdate()
    fun installUpdate()
    fun dismissUpdate()
    fun downloadFile(fileId: String)
    fun openFile(fileId: String)
    fun shareFile(fileId: String)
    fun saveFile(fileId: String)
    fun releaseSession(sessionId: String)
    fun setSkipConfirmations(on: Boolean)
    fun setPlainUpdates(on: Boolean)
    suspend fun scanQr(): String?
    suspend fun pair(json: String): PairResult
    fun unpair()
    fun setSpeechRate(rate: Float)
    fun setIdleTimeout(min: Int)
    fun setKeepScreenOn(on: Boolean)
    fun testVoice()
    fun loadVoices()
    fun setVoice(name: String?)
    fun openSpeechSettings()
    fun reconnect()
    fun requestPermissions()
    fun requestBatteryExemption()
    fun finishOnboarding()
    fun consumeNotice(id: Long)
}

data class PermissionState(val mic: Boolean, val notifications: Boolean, val batteryExempt: Boolean = true)
