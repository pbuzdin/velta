// GameActivity shell for the Velta preview (#315 Phase 0). cargo-apk can only
// ship the framework NativeActivity; GameActivity (androidx.games) is the
// backend with proper IME and insets, so it gets this minimal Gradle project.
// The Rust side is built by cargo with the `game-activity` feature and copied
// into app/src/main/jniLibs/arm64-v8a/; Gradle only packages.
pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "velta-preview"
include(":app")
