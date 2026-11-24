// Central plugin versions: the Kotlin plugins load once for all subprojects
// (composeApp uses KMP, baselineprofile uses kotlin-android — same KGP).
plugins {
    alias(libs.plugins.kotlinMultiplatform) apply false
    alias(libs.plugins.kotlinAndroid) apply false
    alias(libs.plugins.androidApplication) apply false
    alias(libs.plugins.androidTest) apply false
}
