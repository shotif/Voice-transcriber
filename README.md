# Glas — Croatian Voice‑Note Transcriber

Share a WhatsApp voice note (or upload any audio) and get back clean **Croatian
text** you can copy. Runs entirely on **one Cloudflare Worker** — it serves the
static frontend from `public/` **and** proxies to **ElevenLabs Scribe**. No
database, no second service, no CORS.

```
┌─────────────┐   POST /api/transcribe    ┌──────────────────┐   xi-api-key   ┌─────────────┐
│  Browser /  │ ───── multipart audio ───▶│  Worker          │ ─────────────▶ │ ElevenLabs  │
│  PWA (hr)   │ ◀──── { text: "…" } ──────│ src/index.ts     │ ◀── { text } ──│  Scribe     │
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
├── src/
│   └── index.ts               # Worker: serves /public assets + /api/transcribe proxy
├── public/                    # static frontend (served via the ASSETS binding)
│   ├── index.html
│   ├── styles.css
│   ├── app.js
│   ├── manifest.webmanifest   # PWA manifest + share_target
│   ├── sw.js                  # service worker: offline shell + share intake
│   └── icons/                 # generated PWA icons
├── .env.example               # documents ELEVENLABS_API_KEY (safe to commit)
├── wrangler.toml              # Worker config: main + [assets] binding + compat date
├── package.json               # dev tooling only (no runtime deps)
├── tsconfig.json
└── SETUP.md                   # ⭐ beginner-proof, empty → live walkthrough
```

## The ElevenLabs request (verified June 2026)

```
POST {base}/v1/speech-to-text        # base defaults to https://api.elevenlabs.io
Header: xi-api-key: <ELEVENLABS_API_KEY>   # EU accounts: set ELEVENLABS_BASE_URL
multipart/form-data:                       #   = https://api.eu.residency.elevenlabs.io
  file          = <audio>          # .opus/.ogg/.m4a/.mp3/.wav …
  model_id      = scribe_v2        # scribe_v1 is deprecated (removed 2026‑07‑09)
  language_code = hr               # ISO‑639‑1, forces Croatian
```

Response JSON includes `text` (the transcript), `language_code`, and
`language_probability`.

## Quick start

See **[SETUP.md](./SETUP.md)** for the full, click-by-click guide (GitHub →
Cloudflare → secret → live URL → Android share). TL;DR:

1. Push this repo to GitHub.
2. Cloudflare → **Workers & Pages → Create → Import a repository** → pick the repo.
3. Leave the **Deploy command** at the default **`npx wrangler deploy`** (config
   comes from `wrangler.toml`); build command empty.
4. **Settings → Variables and Secrets** → add **`ELEVENLABS_API_KEY`** (and
   **`ELEVENLABS_BASE_URL`** = the EU host if your account is EU).
5. Deploy → open your `*.workers.dev` URL.

## Local development (optional)

```bash
npm install
printf 'ELEVENLABS_API_KEY=sk_your_real_key\n' > .dev.vars   # gitignored
# EU accounts also: printf 'ELEVENLABS_BASE_URL=https://api.eu.residency.elevenlabs.io\n' >> .dev.vars
npm run dev            # wrangler dev  → http://localhost:8787
npm run typecheck      # tsc --noEmit
```
