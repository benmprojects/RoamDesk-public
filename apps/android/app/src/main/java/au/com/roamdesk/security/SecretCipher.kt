package au.com.roamdesk.security

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyStore
import java.security.ProviderException
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Encrypts the device secret with a non-exportable AES-256-GCM key held in Android Keystore
 * (StrongBox when the phone has it). Call off the main thread.
 *
 * The key doesn't require user authentication, because the Drive service must reconnect with the screen off;
 * the biometric "unlock window" is enforced by the app before any command is sent.
 */
class SecretCipher(private val alias: String = "claude_anywhere_device_secret_v1") {

    private fun keyStore(): KeyStore = KeyStore.getInstance(KEYSTORE).apply { load(null) }

    private fun key(): SecretKey = (keyStore().getKey(alias, null) as? SecretKey) ?: generate()

    private fun generate(): SecretKey {
        fun spec(strongBox: Boolean) = KeyGenParameterSpec.Builder(
            alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
        )
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .setRandomizedEncryptionRequired(true)
            .setIsStrongBoxBacked(strongBox)
            .build()

        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
        return try {
            generator.init(spec(strongBox = true))
            generator.generateKey()
        } catch (e: ProviderException) { // includes StrongBoxUnavailableException
            generator.init(spec(strongBox = false))
            generator.generateKey()
        }
    }

    fun encrypt(plain: ByteArray): String {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val ct = cipher.doFinal(plain)
        return Base64Url.encode(cipher.iv) + "." + Base64Url.encode(ct)
    }

    fun decrypt(blob: String): ByteArray {
        val (iv, ct) = blob.split('.').let { require(it.size == 2) { "Bad secret blob" }; Base64Url.decode(it[0]) to Base64Url.decode(it[1]) }
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, iv))
        return cipher.doFinal(ct)
    }

    fun deleteKey() {
        runCatching { keyStore().deleteEntry(alias) }
    }

    private companion object {
        const val KEYSTORE = "AndroidKeyStore"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
    }
}
