# kotlinx.serialization
-keepattributes *Annotation*, InnerClasses
-dontnote kotlinx.serialization.AnnotationsKt
-keepclassmembers class au.com.roamdesk.** {
    *** Companion;
}
-keepclasseswithmembers class au.com.roamdesk.** {
    kotlinx.serialization.KSerializer serializer(...);
}
-keep,includedescriptorclasses class au.com.roamdesk.**$$serializer { *; }

# OkHttp
-dontwarn okhttp3.internal.platform.**
-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.**
-dontwarn org.openjsse.**
