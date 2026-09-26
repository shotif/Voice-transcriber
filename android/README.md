# Glas prijepis — native Android share target

A one-screen Android app that receives a shared voice note, transcribes it
through the Glas Worker, and hands the transcript to the installed Glas app.

## Why this exists

Chrome's Web Share Target never delivered the file on the affected device. The
PWA's service worker received an empty multipart body (and, before the manifest
was narrowed, a body containing nothing but the share's title), while the same
voice note attached normally when shared to other apps. Chrome resolves a
shared file's type through `ContentResolver` **after** the WebAPK has forwarded
the intent to the browser, and if that read fails the file is dropped without a
word.

An `ACTION_SEND` intent handled by a normal Android activity has no such second
hop: the read grant applies directly to the receiving activity, which is why
Gmail works. This app is that activity.

## What it does

1. Appears in the share sheet for audio (and the container types Android hands
   out for voice notes).
2. Reads the shared clip and POSTs it to `/api/transcribe?handoff=1` with the
   same access code, name and device id headers the web app sends — so the
   daily rate limit and the admin log keep working as one account.
3. Copies the transcript to the clipboard straight away and shows it.
4. **U Glas** opens `/?pickup=<id>`, where Glas collects the transcript *and the
   clip* and saves them to its own history, so the audio player, click-to-listen
   and the AI tools all work exactly as for a file uploaded in the browser. The
   parked transcript is one-shot and expires after an hour.

No dependencies, no AndroidX — one activity on the framework, a few hundred
kilobytes.

## Build

### Android Studio (easiest)

1. **File → Open**, pick this `android/` folder, let it sync (it will fetch
   Gradle and the Android SDK components it needs).
2. **Build → Build Bundle(s) / APK(s) → Build APK(s)**.
3. The APK lands in `android/app/build/outputs/apk/debug/app-debug.apk`.

### Command line

Needs JDK 17 and the Android SDK (`ANDROID_HOME` set). From `android/`:

```bash
gradle wrapper          # once, if ./gradlew is missing
./gradlew assembleDebug
```

Same output path as above.

## Install on the phone

Transfer `app-debug.apk` to the phone (USB, Quick Share, Drive) and tap it. The
first time, Android asks you to allow installs from whichever app opened the
file — allow it for that app only.

With the phone plugged in and USB debugging on, this is quicker:

```bash
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

## First run

Open **Glas prijepis** from the app drawer once and fill in:

- **Pristupni kôd** — the same access code you use in Glas (`APP_PASSCODE`).
- **Tvoje ime** — optional, shows up in the admin log.
- **Adresa Glasa** — defaults to `https://glas.shotif.workers.dev`.

Then: WhatsApp → long-press the voice note → ⋮ → **Share** → **Glas prijepis**.

The access code is stored in the app's private `SharedPreferences`. No API key
ever reaches the phone — the app only ever talks to the Worker, which holds the
keys.
