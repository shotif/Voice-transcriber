plugins {
  id("com.android.application")
}

// Deliberately dependency-free: the whole app is one Activity built on the
// framework, so it compiles without AndroidX and stays a few hundred kilobytes.
android {
  namespace = "dev.shotif.glasshare"
  compileSdk = 35

  defaultConfig {
    applicationId = "dev.shotif.glasshare"
    minSdk = 24
    targetSdk = 35
    versionCode = 1
    versionName = "1.0"
  }

  buildTypes {
    release {
      isMinifyEnabled = false
    }
  }

  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }
}
