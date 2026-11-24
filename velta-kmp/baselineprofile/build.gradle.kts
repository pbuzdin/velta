// #507: baseline-profile generator + macrobenchmarks for the KMP app.
// Manual runs only (needs a device/emulator, API 28+):
//   ./gradlew :composeApp:generateReleaseBaselineProfile   # writes the profile
//   ./gradlew :composeApp:assembleBenchmark                 # benchmarkable APK
//   ./gradlew :baselineprofile:connectedBenchmarkAndroidTest # the benchmarks
// The scroll benchmarks measure the real chat list/history when the target
// device has a configured profile (the app boots to the chat list).
plugins {
    alias(libs.plugins.androidTest)
    alias(libs.plugins.kotlinAndroid)
    alias(libs.plugins.baselineprofile)
}

android {
    namespace = "org.velta.kmp.baselineprofile"
    compileSdk = libs.versions.compileSdk.get().toInt()

    defaultConfig {
        minSdk = 28
        targetSdk = libs.versions.targetSdk.get().toInt()
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    targetProjectPath = ":composeApp"
    experimentalProperties["android.experimental.self-instrumenting"] = true

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_21
        targetCompatibility = JavaVersion.VERSION_21
    }
}

kotlin {
    jvmToolchain(21)
}

dependencies {
    implementation(libs.androidx.test.runner)
    implementation(libs.androidx.benchmark.macro.junit4)
    implementation(libs.androidx.uiautomator)
}
