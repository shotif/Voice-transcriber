# Glas — iOS Shortcut

iOS doesn't support Web Share Targets, so to get a one-tap "Share voice note →
Croatian text" on iPhone we use an **Apple Shortcut**. It appears in the iOS
share sheet, POSTs the shared audio to `/api/transcribe`, and copies the
transcript to the clipboard.

This works against the same backend as the web app — it just sends the audio as
the raw request body with the `x-app-passcode` header.

## Files

- `Glas-prijepis.plist` — a ready-made shortcut. You must replace the passcode
  placeholder `__ZAMIJENI_PRISTUPNI_KOD__` with your real `APP_PASSCODE`
  (either edit the file before sending, or fix it on-device after import).

## Importing the .plist on an iPhone

1. On the iPhone: **Settings → Shortcuts → enable "Allow Untrusted Shortcuts"**
   (you may need to run any one shortcut first for the toggle to appear).
2. Rename `Glas-prijepis.plist` to **`Glas-prijepis.shortcut`** and open it
   (AirDrop / Files / email). Tap **Add Shortcut**.
3. Open the shortcut, find the **Get Contents of URL** action, and in the
   `x-app-passcode` header replace `__ZAMIJENI_PRISTUPNI_KOD__` with the real
   access code.
4. In the shortcut settings (ⓘ), confirm **Show in Share Sheet** is on.

> Unsigned-shortcut import is finicky across iOS versions. If the file won't
> import, just build it by hand in ~2 minutes using the steps below — that path
> always works.

## Building it by hand (reliable fallback)

In the **Shortcuts** app → **+** → name it **Glas prijepis**:

1. ⓘ → enable **Show in Share Sheet**; accept types **Media** + **Files**.
   Set **If there's no input → Ask For → Files**.
2. **Get Contents of URL**:
   - URL: `https://glas.shotif.workers.dev/api/transcribe`
   - Show More → Method **POST**
   - Header: `x-app-passcode` = your access code (optionally `x-user-label` = name)
   - Request Body: **File** → value = **Shortcut Input**
3. **Get Dictionary Value** → value for **text**.
4. **Copy to Clipboard**.
5. **Quick Look** (to show the text).

## Sharing with friends

After it works, in Shortcuts long-press it → **Share → Copy iCloud Link** and
send that link to other iPhone users (the link carries the configured passcode,
so treat it like the passcode itself).

## Using it

In WhatsApp: long-press a voice note → **Share** → **Glas prijepis** → the
Croatian text is copied to the clipboard and shown.
