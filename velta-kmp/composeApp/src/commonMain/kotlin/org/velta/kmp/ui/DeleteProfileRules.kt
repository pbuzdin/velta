package org.velta.kmp.ui

/**
 * Delete the profile you are in (#358 C, web danger tab). Type the address,
 * refuse the last profile. No Compose here.
 */

/** Web hides the form when `state.accounts.length <= 1`. */
fun canDeleteProfile(accountCount: Int): Boolean = accountCount > 1

/** Web: trim + case-insensitive. A blank address never matches. */
fun deleteAddressMatches(typed: String, addr: String): Boolean {
    val want = addr.trim()
    if (want.isEmpty()) return false
    return typed.trim().equals(want, ignoreCase = true)
}

/**
 * Web `deleteAccount` after `remove_account`: empty remaining refuses.
 * The deleted id is filtered out so a static fixture that still lists it
 * cannot be selected again. A live core has already dropped it, so the
 * filter changes nothing and the rest is `ids.includes(selected) ? selected : ids[0]`.
 */
fun profileAfterDelete(remaining: List<Long>, selected: Long?, deleted: Long): Long? {
    val ids = remaining.filter { it != deleted }
    if (ids.isEmpty()) return null
    return if (selected != null && selected in ids) selected else ids.first()
}
