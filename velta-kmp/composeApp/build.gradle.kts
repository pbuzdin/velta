import org.jetbrains.compose.desktop.application.dsl.TargetFormat
import java.util.Properties

plugins {
    alias(libs.plugins.kotlinMultiplatform)
    alias(libs.plugins.androidApplication)
    alias(libs.plugins.composeMultiplatform)
    alias(libs.plugins.composeCompiler)
    alias(libs.plugins.kotlinSerialization)
}

// Release signing reads keystore.properties (gitignored) when present;
// without it, release APKs fall back to the debug key so they stay
// installable — the production keystore decision is tracked in P5.
val keystoreProps = Properties().apply {
    val f = rootProject.file("keystore.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}
val hasReleaseKeystore = keystoreProps.isNotEmpty()

// UnifiedPush VAPID public key. Same property/env as the Tauri Android
// shell so the two clients cannot drift. Override: -PveltaVapidKey=...
// or env VELTA_VAPID_KEY. Default is the upstream chatmail notifier key.
val veltaVapidKey = (project.findProperty("veltaVapidKey") as String?)
    ?.takeIf { it.isNotBlank() }
    ?: System.getenv("VELTA_VAPID_KEY")?.takeIf { it.isNotBlank() }
    ?: "BHNce1sXk99bpkFFYwiSR3Lp4n54PiS-Y0S9iX6R7va7sxQ5hE7ll6DMKlKs2tFT9POq92gLygezT7o0fkQU8NE"
fun quoted(s: String) = "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"") + "\""

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
            implementation(compose.components.resources)
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
            implementation(libs.androidx.fragment.ktx)
            implementation(libs.zxing.core)
            implementation(libs.camera.camera2)
            implementation(libs.camera.lifecycle)
            implementation(libs.camera.view)
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
                implementation(libs.zxing.core)
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
        buildConfigField("String", "VAPID_KEY", quoted(veltaVapidKey))
    }

    buildFeatures {
        buildConfig = true
    }

    signingConfigs {
        if (hasReleaseKeystore) {
            create("release") {
                storeFile = file(keystoreProps.getProperty("storeFile"))
                storePassword = keystoreProps.getProperty("storePassword")
                keyAlias = keystoreProps.getProperty("keyAlias")
                keyPassword = keystoreProps.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
            if (hasReleaseKeystore) {
                signingConfig = signingConfigs.getByName("release")
            } else {
                signingConfig = signingConfigs.getByName("debug")
            }
        }
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

compose.resources {
    publicResClass = true
    packageOfResClass = "org.velta.kmp.generated.resources"
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
