# Glas — iOS Shortcut

iOS doesn't support Web Share Targets, so to get a one-tap "Share voice note →
Croatian text" on iPhone we use an **Apple Shortcut**. It appears in the iOS
share sheet, POSTs the shared audio to `/api/transcribe` (as a raw body with the
`x-app-passcode` header), and copies the transcript to the clipboard.

## Important: how shortcuts can be installed on modern iOS

On **iOS 15 and later, Apple removed unsigned-shortcut import** (the old "Allow
Untrusted Shortcuts" toggle is gone — newer iOS only has "Private Sharing", which
is for receiving iCloud links from contacts). A shortcut can only be installed
via an **iCloud link signed by Apple**, which is generated when someone **builds
the shortcut on an Apple device** and shares it.

So the `Glas-prijepis.plist` file here **will not import on iOS 15+**. It is kept
only as a human-readable reference of the actions. The supported path is:

> **One person with an iPhone builds the shortcut once (below), then shares its
> iCloud link** with everyone else. Build once, share forever — no Mac needed.

## Build it (≈2 minutes, on any iPhone)

In the **Shortcuts** app → **+**, name it **Glas prijepis**:

1. **Add Action → "Get Contents of URL"**:
   - URL: `https://glas.shotif.workers.dev/api/transcribe`
   - Show More → Method **POST**
   - Header: `x-app-passcode` = your access code (optionally `x-user-label` = name)
   - Request Body: **File** → value = **Shortcut Input**
2. **Get Dictionary Value** → value for **text** in **Contents of URL**.
3. **Copy to Clipboard**.
4. **Quick Look** (to show the text).
5. Tap **ⓘ** → enable **Show in Share Sheet** (accept Media + Files).
6. **Done.**

The Worker accepts the shared file as a raw request body, so no multipart "Form"
field is needed — Request Body = File = Shortcut Input is enough.

## Share with friends

In Shortcuts, long-press it → **Share → Copy iCloud Link** and send that link to
other iPhone users. The link is signed by Apple, so it installs on any iPhone
(recipients may toggle Settings → Shortcuts → **Private Sharing** on). The link
carries the configured passcode, so treat it like the passcode itself.

## Using it

In WhatsApp: long-press a voice note → **Share** → **Glas prijepis** → the
Croatian text is copied to the clipboard and shown.
