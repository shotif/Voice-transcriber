# Glas — Croatian Voice‑Note Transcriber

Share a WhatsApp voice note (or upload any audio) and get back clean **Croatian
text** you can copy. Runs entirely on **one Cloudflare Pages project** — static
frontend + a Pages Function proxy to **ElevenLabs Scribe**. No database, no
second service, no CORS.

```
┌─────────────┐   POST /api/transcribe    ┌──────────────────┐   xi-api-key   ┌─────────────┐
│  Browser /  │ ───── multipart audio ───▶│  Pages Function  │ ─────────────▶ │ ElevenLabs  │
│  PWA (hr)   │ ◀──── { text: "…" } ──────│ functions/api/…  │ ◀── { text } ──│  Scribe     │
└─────────────┘                           └──────────────────┘                └─────────────┘
   same-origin, no CORS         secret key lives ONLY here (env var)
```

## Features

- 📤 Mobile-first upload / drag-&-drop + file picker
- 🗣️ Forces **Croatian** (`language_code=hr`) on **ElevenLabs Scribe**
- 🎧 Filename + inline audio player to replay while reading
- 📋 One-tap **Copy**, with graceful error handling
- 🕑 Last ~10 transcripts cached in **localStorage** (with clear/delete)
- 📱 **Installable PWA** + **Android Web Share Target** — share a WhatsApp voice
  note straight into the app
- 🔒 API key is a **Cloudflare secret**, never in client code or the bundle

## Repo layout

```
.
├── functions/
│   └── api/
│       └── transcribe.ts      # Pages Function: same-origin proxy to ElevenLabs
├── public/                    # static frontend (this is the build output dir)
│   ├── index.html
│   ├── styles.css
│   ├── app.js
│   ├── manifest.webmanifest   # PWA manifest + share_target
│   ├── sw.js                  # service worker: offline shell + share intake
│   └── icons/                 # generated PWA icons
├── .env.example               # documents ELEVENLABS_API_KEY (safe to commit)
├── wrangler.toml              # optional CLI config (output dir, compat date)
├── package.json               # dev tooling only (no runtime deps)
├── tsconfig.json
└── SETUP.md                   # ⭐ beginner-proof, empty → live walkthrough
```

## The ElevenLabs request (verified June 2026)

```
POST https://api.elevenlabs.io/v1/speech-to-text
Header: xi-api-key: <ELEVENLABS_API_KEY>
multipart/form-data:
  file          = <audio>          # .opus/.ogg/.m4a/.mp3/.wav …
  model_id      = scribe_v2        # scribe_v1 is deprecated (removed 2026‑07‑09)
  language_code = hr               # ISO‑639‑1, forces Croatian
```

Response JSON includes `text` (the transcript), `language_code`, and
`language_probability`.

## Quick start

See **[SETUP.md](./SETUP.md)** for the full, click-by-click guide (GitHub →
Cloudflare Pages → secret → live URL → Android share). TL;DR:

1. Push this repo to GitHub.
2. Cloudflare → **Workers & Pages → Create → Pages → Connect to Git**.
3. Build command: *(leave empty)* · Build output directory: **`public`**.
4. **Settings → Variables and Secrets** → add secret **`ELEVENLABS_API_KEY`**.
5. Deploy → open your `*.pages.dev` URL.

## Local development (optional)

```bash
npm install
echo "ELEVENLABS_API_KEY=sk_your_real_key" > .dev.vars   # gitignored
npm run dev            # wrangler pages dev public  → http://localhost:8788
npm run typecheck      # tsc --noEmit
```
