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

## Build it (≈1 minute, on any iPhone)

The Worker can return the transcript as **plain text** via `?format=text`, so the
Shortcut needs no JSON parsing — just fetch, copy, show. In the **Shortcuts** app
→ **+**, name it **Glas prijepis**:

1. **Add Action → "Get Contents of URL"**:
   - URL: `https://glas.shotif.workers.dev/api/transcribe?format=text`
   - Show More → Method **POST**
   - Header — set **Key** = `x-app-passcode`, **Value** = your access code
     (optionally a second header `x-user-label` = your name)
   - Request Body: **File** → value = **Shortcut Input**
2. **Copy to Clipboard** (copies the URL contents).
3. **Quick Look** (to show the text).
4. Tap **ⓘ** → enable **Show in Share Sheet** (accept Media + Files).
5. **Done.**

No "Get Dictionary Value" needed — `?format=text` returns the raw transcript, so
the response is copied directly. (Without `?format=text` the endpoint returns
JSON `{ "text": ... }`, which is what the web app uses.)

> ⚠️ Common mistake: putting the passcode in the header **Key** field. The Key
> must be `x-app-passcode`; the passcode goes in the **Value** field.

## Share with friends

In Shortcuts, long-press it → **Share → Copy iCloud Link** and send that link to
other iPhone users. The link is signed by Apple, so it installs on any iPhone
(recipients may toggle Settings → Shortcuts → **Private Sharing** on). The link
carries the configured passcode, so treat it like the passcode itself.

## Using it

In WhatsApp: long-press a voice note → **Share** → **Glas prijepis** → the
Croatian text is copied to the clipboard and shown.
