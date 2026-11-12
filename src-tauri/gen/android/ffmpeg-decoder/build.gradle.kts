// ExoPlayer's FFmpeg audio decoder (androidx/media 1.8.0, libraries/decoder_ffmpeg, Apache 2.0),
// so lossless files play the same on every device instead of depending on the maker's decoders.
// FFmpeg itself is LGPL, built from source by packaging/build-ffmpeg.sh into .build-tools/ffmpeg-src
// (src/main/jni/ffmpeg links there).
plugins {
    id("com.android.library")
}

android {
    namespace = "androidx.media3.decoder.ffmpeg"
    compileSdk = 37
    ndkVersion = "28.2.13676358"
    defaultConfig {
        minSdk = 24
        consumerProguardFiles("proguard-rules.txt")
    }
    externalNativeBuild {
        cmake {
            path = file("src/main/jni/CMakeLists.txt")
            version = "3.22.1"
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
}

dependencies {
    api("androidx.media3:media3-decoder:1.8.0")
    implementation("androidx.media3:media3-exoplayer:1.8.0")
    implementation("androidx.annotation:annotation:1.9.1")
    compileOnly("org.checkerframework:checker-qual:3.49.3")
    compileOnly("org.jetbrains.kotlin:kotlin-annotations-jvm:1.9.24")
}
