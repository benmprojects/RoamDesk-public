import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
    id("org.jetbrains.kotlin.plugin.serialization")
}

// Upload-key details live outside the repository: %USERPROFILE%\ClaudeAnywhereKeys\keystore.properties
// (storeFile, storePassword, keyAlias, keyPassword). Without it the release build is simply left unsigned.
val signingProps = Properties().apply {
    val f = File(System.getProperty("user.home"), "ClaudeAnywhereKeys/keystore.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}

android {
    namespace = "au.com.roamdesk"
    compileSdk = 36

    defaultConfig {
        // Permanent once the first build is uploaded to Google Play.
        applicationId = "au.com.roamdesk"
        minSdk = 29
        targetSdk = 36
        // Every build gets a higher versionCode (minutes since 2025-12-01), so the in-app updater can tell newer from older.
        val buildMinute = ((System.currentTimeMillis() / 60_000L) - 29_396_160L).toInt()
        versionCode = buildMinute
        versionName = "0.2.$buildMinute"
    }

    // sideload: installed with adb and updated from the PC by the in-app updater.
    // play: for Google Play, which doesn't allow apps to install their own updates; Android Auto gets the full templated app.
    flavorDimensions += "dist"
    productFlavors {
        create("sideload") {
            dimension = "dist"
            buildConfigField("boolean", "SELF_UPDATE", "true")
            // May fall back to plain ws:// over the Tailscale address (helpers without the HTTPS link).
            buildConfigField("boolean", "ALLOW_PLAIN", "true")
        }
        create("play") {
            dimension = "dist"
            buildConfigField("boolean", "SELF_UPDATE", "false")
            // Encrypted HTTPS link only; no cleartext traffic at all.
            buildConfigField("boolean", "ALLOW_PLAIN", "false")
        }
    }

    signingConfigs {
        if (signingProps.getProperty("storeFile") != null) {
            create("upload") {
                storeFile = File(signingProps.getProperty("storeFile"))
                storePassword = signingProps.getProperty("storePassword")
                keyAlias = signingProps.getProperty("keyAlias")
                keyPassword = signingProps.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = signingConfigs.findByName("upload")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    buildFeatures {
        compose = true
        buildConfig = true
    }
    testOptions {
        unitTests.isReturnDefaultValues = true
    }
    packaging {
        resources.excludes += setOf("/META-INF/{AL2.0,LGPL2.1}", "/META-INF/versions/9/previous-compilation-data.bin")
    }
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2024.09.00")
    implementation(composeBom)
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")
    implementation("androidx.compose.animation:animation")
    debugImplementation("androidx.compose.ui:ui-tooling")

    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.activity:activity-compose:1.9.2")
    implementation("androidx.fragment:fragment-ktx:1.8.3")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.6")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.6")
    implementation("androidx.datastore:datastore-preferences:1.1.1")
    implementation("androidx.biometric:biometric:1.1.0")
    implementation("androidx.car.app:app:1.4.0")
    implementation("androidx.car.app:app-projected:1.4.0")

    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("com.google.android.gms:play-services-code-scanner:16.1.0")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.8.1")
}
