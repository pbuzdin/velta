package org.velta.kmp.ui

/**
 * App-lock policy (#334 step 4), pure so it is unit-tested.
 *
 * The bio-wrap KEK (VeltaKeystore.bioKek) accepts STRONG biometrics or the
 * device credential (API 30+: AUTH_BIOMETRIC_STRONG | AUTH_DEVICE_CREDENTIAL;
 * below 30: a 30 s auth-validity key, which only strong biometrics or the
 * credential unlock). The prompt must never accept LESS than that — a
 * Class 2 (weak) face unlock passed the old BIOMETRIC_WEAK prompt, then the
 * key refused it and enabling/unlocking failed silently. Mirrors stable's
 * VeltaLock.AUTHENTICATORS (velta-app gen/android).
 */
object LockPolicy {
    /** What the BiometricPrompt may offer on [sdk]. */
    data class Authenticators(val strongBiometric: Boolean, val deviceCredential: Boolean) {
        /** BiometricPrompt requires a negative button when the credential
         * is not one of the options. */
        val needsNegativeButton: Boolean get() = !deviceCredential
    }

    /**
     * [withCrypto]: the prompt carries a CryptoObject (the per-use bio key).
     * Before API 30 a CryptoObject cannot be combined with the device
     * credential, so only a strong biometric is offered there.
     */
    fun authenticators(sdk: Int, withCrypto: Boolean = false): Authenticators = when {
        withCrypto && sdk < 30 -> Authenticators(strongBiometric = true, deviceCredential = false)
        sdk >= 30 -> Authenticators(strongBiometric = true, deviceCredential = true)
        // API 28-29: BiometricPrompt rejects STRONG | DEVICE_CREDENTIAL;
        // strong biometric only (stable does the same).
        sdk >= 28 -> Authenticators(strongBiometric = true, deviceCredential = false)
        // API 26-27: the compat prompt handles STRONG | DEVICE_CREDENTIAL.
        else -> Authenticators(strongBiometric = true, deviceCredential = true)
    }

    /** Stable's "Lock when hidden" choices (minutes; 0 = off, the default). */
    val AUTOLOCK_CHOICES = listOf(0, 1, 5, 15)

    /** Lock on return when the app was hidden at least [mins] minutes. */
    fun shouldAutoLock(hiddenAtMillis: Long?, nowMillis: Long, mins: Int): Boolean =
        hiddenAtMillis != null && mins > 0 && nowMillis - hiddenAtMillis >= mins * 60_000L
}
