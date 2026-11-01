import org.jetbrains.compose.desktop.application.dsl.TargetFormat

plugins {
    alias(libs.plugins.kotlinMultiplatform)
    alias(libs.plugins.androidApplication)
    alias(libs.plugins.composeMultiplatform)
    alias(libs.plugins.composeCompiler)
    alias(libs.plugins.kotlinSerialization)
}

kotlin {
    androidTarget()
    jvm("desktop")
    jvmToolchain(21)

    sourceSets {
        commonMain.dependencies {
            implementation(compose.runtime)
            implementation(compose.foundation)
            implementation(compose.material3)
            implementation(compose.ui)
            implementation(libs.kotlinx.coroutines.core)
            implementation(libs.kotlinx.serialization.json)
        }
        // Shared JVM layer: the JSON-RPC client + process transport are
        // identical on Android and desktop — this is the KMP boundary
        // (core bridge in jvmCommon, entry points + platform seam per target).
        val jvmCommon by creating {
            dependsOn(commonMain.get())
        }
        androidMain.get().dependsOn(jvmCommon)
        androidMain.dependencies {
            implementation(libs.androidx.activity.compose)
            implementation(libs.unifiedpush.connector)
            implementation(libs.androidx.biometric)
        }
        val desktopMain by getting {
            dependsOn(jvmCommon)
            dependencies {
                implementation(compose.desktop.currentOs)
            }
        }
        val desktopTest by getting {
            dependencies {
                implementation(kotlin("test"))
            }
        }
    }
}

android {
    namespace = "org.velta.kmp"
    compileSdk = libs.versions.compileSdk.get().toInt()

    defaultConfig {
        // org.velta.kmp stays side-by-side with the Tauri APK (org.velta).
        applicationId = "org.velta.kmp"
        minSdk = libs.versions.minSdk.get().toInt()
        targetSdk = libs.versions.targetSdk.get().toInt()
        versionCode = 1
        versionName = "0.1.0"
    }

    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_21
        targetCompatibility = JavaVersion.VERSION_21
    }
}

compose.desktop {
    application {
        mainClass = "org.velta.kmp.MainKt"
        nativeDistributions {
            targetFormats(TargetFormat.Deb, TargetFormat.Msi)
            packageName = "Velta"
            packageVersion = "0.1.0"
        }
    }
}
