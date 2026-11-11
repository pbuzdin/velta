plugins {
    id("com.android.application")
}

android {
    namespace = "cc.velta.preview"
    compileSdk = 35

    defaultConfig {
        applicationId = "cc.velta.preview"
        minSdk = 28
        targetSdk = 35
        // Above cargo-apk's computed versionCode (16777472 for 0.1.0), so a
        // Gradle APK installs over an existing cargo-apk NativeActivity one.
        versionCode = 16800000
        versionName = "0.1"
        ndk {
            abiFilters += "arm64-v8a"
        }
    }

    // Same throwaway test key the cargo-apk builds use, so either flavor
    // installs over the other. CI exports the vars; without them the
    // release APK stays unsigned and local debug builds sign normally.
    signingConfigs {
        create("test") {
            System.getenv("VELTA_KEYSTORE")?.let { keystore ->
                storeFile = file(keystore)
                storePassword = System.getenv("VELTA_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("VELTA_KEY_ALIAS")
                keyPassword = System.getenv("VELTA_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            if (System.getenv("VELTA_KEYSTORE") != null) {
                signingConfig = signingConfigs.getByName("test")
            }
        }
    }

    packaging {
        // GameActivity dlopen's libvelta_preview.so from disk, not the APK.
        jniLibs {
            useLegacyPackaging = true
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    implementation("androidx.games:games-activity:4.4.2")
    // games-activity's GameActivity extends AppCompatActivity and uses
    // androidx.core insets APIs, but its POM declares no dependencies.
    implementation("androidx.appcompat:appcompat:1.7.1")
    constraints {
        // kotlin-stdlib 1.8 merged the jdk7/jdk8 variants; some transitive
        // dep still pins the 1.6.21 ones and dexing sees duplicate classes.
        implementation("org.jetbrains.kotlin:kotlin-stdlib-jdk7:1.8.22") {
            because("kotlin-stdlib 1.8+ already contains the jdk7 classes")
        }
        implementation("org.jetbrains.kotlin:kotlin-stdlib-jdk8:1.8.22") {
            because("kotlin-stdlib 1.8+ already contains the jdk8 classes")
        }
    }
}
