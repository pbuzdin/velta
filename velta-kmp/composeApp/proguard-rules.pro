# JNI: the shim resolves these by symbol name — never rename.
-keepclasseswithmembernames class org.velta.kmp.core.RpcShim {
    native <methods>;
}

# kotlinx.serialization (R8 full mode): keep serializers for the wire models.
-keepclassmembers class kotlinx.serialization.json.** {
    *** Companion;
}
-keepclasseswithmembers class kotlinx.serialization.json.** {
    kotlinx.serialization.KSerializer serializer(...);
}
-keep,includedescriptorclasses class org.velta.kmp.**$$serializer { *; }
-keepclassmembers class org.velta.kmp.** {
    *** Companion;
}
-keepclasseswithmembers class org.velta.kmp.** {
    kotlinx.serialization.KSerializer serializer(...);
}

# UnifiedPush connector dispatches into the service by manifest intent.
-keep class org.unifiedpush.android.connector.** { *; }
-keep class org.velta.kmp.push.VeltaPushService { *; }
