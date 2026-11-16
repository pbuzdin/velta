package org.velta.kmp.ui

/**
 * Own-profile editor (#358 C) — a pure port of stable ui.js
 * `showEditProfile` + app.js `editProfileFlow` and rpc-core
 * setDisplayName / setAvatar / setSelfStatus.
 * No Compose here: ProfileEditRulesTest pins every rule.
 */

/** Stable `<input maxlength="64">` on the name. */
const val PROFILE_NAME_MAX = 64

/** The picture choice the editor hands back (stable "keep" / "remove" / picked). */
sealed interface AvatarChange {
    data object Keep : AvatarChange
    data object Remove : AvatarChange
    data class Picked(val path: String) : AvatarChange
}

/** Stable submit(): name and description trimmed; picture keep/remove/picked. */
data class ProfileEdit(val name: String, val description: String, val avatar: AvatarChange)

fun profileEditOf(nameInput: String, descInput: String, picked: String?, removed: Boolean): ProfileEdit =
    ProfileEdit(
        name = nameInput.trim(),
        description = descInput.trim(),
        avatar = when {
            removed -> AvatarChange.Remove
            picked != null -> AvatarChange.Picked(picked)
            else -> AvatarChange.Keep
        },
    )

/** Name field input: stable's maxlength cuts at 64 characters. */
fun clampProfileName(input: String): String = input.take(PROFILE_NAME_MAX)

/** The preview's picture: none once removed, the new pick, else the current one. */
fun previewAvatar(current: String?, picked: String?, removed: Boolean): String? =
    if (removed) null else picked ?: current?.takeIf { it.isNotBlank() }

/** Stable shows "Remove photo" only while there is a picture to remove. */
fun showsRemovePhoto(current: String?, picked: String?, removed: Boolean): Boolean =
    previewAvatar(current, picked, removed) != null

/**
 * editProfileFlow's `set_config` writes, in stable's order:
 * displayname (blank → null), then selfavatar (remove → null, picked →
 * path, keep → nothing), then selfstatus only when it changed (blank → null).
 */
fun profileConfigWrites(edit: ProfileEdit, oldStatus: String): List<Pair<String, String?>> = buildList {
    add("displayname" to edit.name.ifBlank { null })
    when (val a = edit.avatar) {
        AvatarChange.Remove -> add("selfavatar" to null)
        is AvatarChange.Picked -> add("selfavatar" to a.path)
        AvatarChange.Keep -> {}
    }
    if (edit.description != oldStatus) add("selfstatus" to edit.description.ifBlank { null })
}

/** Stable showChatInfo: "Edit profile" sits on the self contact's sheet. */
fun showsEditProfile(contactId: Long?): Boolean = contactId == 1L
