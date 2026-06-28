# Glas — Setup, from empty to live

This guide takes you from **nothing** to a **live `*.pages.dev` URL** that
transcribes Croatian voice notes, then installs it on Android so you can share
WhatsApp voice messages straight into it.

**You need three free things:**
- A **GitHub** account
- A **Cloudflare** account (free plan is enough)
- An **ElevenLabs** account with an **API key** (Profile → API Keys)

The **Cloudflare dashboard** is the primary path. Optional `wrangler` CLI steps
are in the boxes marked *CLI alternative*.

> Everything runs on **one** Cloudflare Pages project: it serves the static
> frontend **and** the `/api/transcribe` backend (a Pages Function). Because
> they're the same origin, there's **no CORS** to configure. Your ElevenLabs key
> is stored only as an encrypted Cloudflare secret — never in the code.

---

## 1. Put this code on GitHub

You have the project files locally (this repo). Create a GitHub repo and push.

### 1a. Create the repository
1. Go to <https://github.com/new>.
2. **Repository name:** e.g. `voice-transcriber` (any name is fine).
3. Visibility: **Private** or **Public** — both work with Cloudflare.
4. **Do NOT** add a README, .gitignore, or license (this repo already has them).
5. Click **Create repository**. Leave the page open — you'll need the URL it
   shows (looks like `https://github.com/<you>/voice-transcriber.git`).

### 1b. Push the code
From the project folder in a terminal:

```bash
git init                 # skip if already a git repo
git add .
git commit -m "Glas: Croatian voice transcriber"
git branch -M main
git remote add origin https://github.com/<you>/voice-transcriber.git
git push -u origin main
```

> If you started from a Claude session branch (e.g.
> `claude/glas-croatian-transcriber-…`), either merge it into `main` first, or
> in step 2 simply pick that branch as the **Production branch**. Cloudflare can
> build from any branch you choose.

Refresh the GitHub page — you should see `functions/`, `public/`, `SETUP.md`, etc.

> 🔒 **Sanity check:** open `.env.example` on GitHub — it should contain only the
> placeholder `your_elevenlabs_api_key_here`, never your real key. Your real key
> goes into Cloudflare in step 3, not into the repo.

---

## 2. Create the Cloudflare Pages project & connect GitHub

1. Sign in at <https://dash.cloudflare.com>.
2. In the left sidebar click **Workers & Pages**.
3. Click **Create** (blue button) → choose the **Pages** tab → **Connect to Git**.
4. **Connect GitHub** → authorize Cloudflare → choose **Only select
   repositories** → pick `voice-transcriber` → **Install & Authorize**.
5. Back in Cloudflare, select that repository → **Begin setup**.

### Build settings — type these exactly

| Field | Value |
|---|---|
| **Project name** | `glas` (this becomes `glas.pages.dev`; pick what you like) |
| **Production branch** | `main` (or your Claude branch) |
| **Framework preset** | **None** |
| **Build command** | *(leave empty)* |
| **Build output directory** | **`public`** |
| **Root directory** | *(leave as the repo root, i.e. `/`)* |

Why these values:
- There is **no build step** — the frontend is plain HTML/CSS/JS that's served
  as-is, and Cloudflare compiles `functions/` automatically. So the build
  command is empty.
- The static files live in **`public/`**, so that's the output directory. ⚠️ This
  is the #1 thing people get wrong — if you point it at the repo root, your pages
  won't serve correctly.

Don't click the final deploy yet — **add the secret first** (next step) so the
very first deploy already has the key. (If you do deploy first, that's fine too;
just re-deploy after adding the secret.)

> **CLI alternative (instead of steps 2–3 dashboard):**
> ```bash
> npm install
> npx wrangler login
> npx wrangler pages project create glas --production-branch main
> npx wrangler pages secret put ELEVENLABS_API_KEY        # paste key when prompted
> npx wrangler pages deploy public                        # build output dir = public
> ```
> Connecting the GitHub repo in the dashboard is still recommended so you get
> auto-deploy on push.

---

## 3. Add `ELEVENLABS_API_KEY` as an encrypted secret

This is the **only** place your real key lives.

1. Open your project: **Workers & Pages → `glas`**.
2. Go to the **Settings** tab.
3. Find **Variables and Secrets** (older UIs: **Environment variables**).
4. Click **+ Add**.
   - **Variable name:** `ELEVENLABS_API_KEY`  *(exact spelling, all caps)*
   - **Value:** paste your real ElevenLabs key (looks like `sk_…`)
   - **Type:** choose **Secret** / **Encrypt** so the value is hidden after saving.
5. **Environment:** add it for **Production**. Then repeat (or use the
   "apply to all environments" toggle if shown) so it's **also set for
   Preview** — otherwise preview deployments from branches/PRs won't transcribe.
6. Click **Save**.

> If you added the variable **after** the first deploy, trigger a fresh deploy so
> the new value is picked up: **Deployments → … → Retry deployment**, or just
> push a commit.

Optional extra variables (only if ElevenLabs ever changes things — defaults are
baked in, so you normally add nothing):
- `ELEVENLABS_MODEL_ID` — defaults to `scribe_v2`.
- `ELEVENLABS_LANGUAGE_CODE` — defaults to `hr` (Croatian).

> **CLI alternative:** `npx wrangler pages secret put ELEVENLABS_API_KEY`
> (and again with `--env preview` for the preview environment).

---

## 4. Confirm the Function and `/api/transcribe` route are live

1. Click **Save and Deploy** (or **Deployments → Retry** if you deployed earlier).
2. Wait for the build to go **Success** (usually well under a minute).
3. Cloudflare auto-detects the Pages Function. To confirm: open
   **`https://<your-project>.pages.dev/api/transcribe`** in a browser (a plain
   **GET**). You should see JSON like:

   ```json
   { "ok": true, "route": "/api/transcribe",
     "model_id": "scribe_v2", "language_code": "hr",
     "key_configured": true }
   ```

   - `key_configured: true` ✅ means your secret is wired up correctly.
   - `key_configured: false` ❌ means the secret isn't set for this environment —
     go back to step 3 and redeploy.

---

## 5. First deploy & finding your live URL

1. In your project, open the **Deployments** tab.
2. The latest **Production** deployment shows a link like
   **`https://glas.pages.dev`** (your project name) — click it.
3. The app loads. Tap the drop zone, pick a Croatian `.opus`/`.m4a`/`.mp3`,
   tap **Transcribe Croatian**, and you should get Croatian text with a **Copy**
   button. 🎉

Every deployment also gets its own preview URL like
`https://<hash>.glas.pages.dev` — handy for testing a branch before it's live.

---

## 6. Install the PWA on Android & use the Share Target

### Install
1. On your Android phone, open **Chrome** and visit your `*.pages.dev` URL.
2. Tap the **⋮** menu → **Add to Home screen** (or **Install app**) →
   **Install**.
3. A **Glas** icon appears on your home screen. Open it once — it runs
   full-screen (standalone), which also registers it as a share target.

### Share a WhatsApp voice note into Glas
1. Open **WhatsApp** and find a Croatian voice message.
2. **Long-press** the voice message → tap **Forward** (arrow) **or** the
   **Share** (⋯ → Share) option.
   - Tip: if "Share" sends the chat as text, use the **three-dot menu → Share**
     on the individual voice message so Android shares the **audio file**.
3. In the Android share sheet, choose **Glas**.
4. Glas opens with the voice note already loaded (filename + player). Tap
   **Transcribe Croatian** → copy the text.

> **Why this works:** the manifest declares a `share_target` POST to
> `/share-target`; the service worker catches that POST, stashes the audio, and
> hands it to the transcribe screen. The target only appears **after** the PWA is
> installed.

---

## 7. Auto-deploy on push, and rolling back

### Auto-deploy (this is your CI/CD)
- Cloudflare Pages watches your GitHub repo. **Every push to `main` auto-builds
  and deploys to production.** Pushes to other branches create **preview**
  deployments. No GitHub Actions, no extra config.
- Typical loop:
  ```bash
  git add .
  git commit -m "tweak UI"
  git push           # Cloudflare builds & deploys automatically
  ```

### Roll back a bad deploy
1. Project → **Deployments**.
2. Find a previous **Success** deployment you trust.
3. Click its **…** menu → **Rollback to this deployment** (or open it →
   **Manage deployment → Rollback**).
4. Production instantly serves that older build again. (Then fix forward in Git
   and push when ready.)

---

## 8. Troubleshooting

**`key_configured: false`, or transcribe returns "Server is missing
ELEVENLABS_API_KEY".**
The secret isn't set for the environment you're hitting. Re-do step 3 for both
**Production** and **Preview**, then **redeploy** (secrets apply on the next
build, not retroactively).

**"Transcription failed (HTTP 401)" / invalid key.**
The key value is wrong or revoked. Re-copy it from ElevenLabs → **Profile → API
Keys**, update the Cloudflare secret, redeploy.

**The page loads but assets are missing / 404s, or `/api/transcribe` 404s.**
Almost always the **Build output directory** is wrong. It must be **`public`**
(Settings → **Builds & deployments** → edit configuration), and `functions/`
must sit at the **repo root**. Save and redeploy.

**Share Target (Glas) doesn't appear in WhatsApp's share sheet.**
- You must **install the PWA first** (step 6) — the target only registers once
  installed, and only on Android Chrome (not iOS).
- Open the installed Glas app once after installing.
- Make sure you're sharing the **audio file** (long-press the voice message →
  three-dot **Share**), not forwarding the chat as text.
- If it still doesn't show, uninstall and reinstall the PWA to refresh the
  manifest, and confirm the site is served over **HTTPS** (pages.dev always is).

**"That doesn't look like an audio file" or "unsupported audio format".**
Supported: `.opus`, `.ogg`, `.oga`, `.m4a`, `.mp3`, `.wav` (and common
`audio/*`). WhatsApp voice notes are `.opus`/`.ogg` and work. If a file is
renamed with the wrong extension, fix the extension and retry.

**"Transcription failed (HTTP 422)".**
ElevenLabs couldn't decode the audio (corrupted or truly unsupported). Try
re-downloading/exporting the voice note, or convert it to `.mp3`/`.wav`.

**Nothing happens / network error.**
Check you're online; open the browser dev console for the exact message. The
`/api/transcribe` GET health check (step 4) is the fastest way to confirm the
backend is alive.

---

## What I could NOT fully verify (please double-check)

I built against the **current ElevenLabs Speech-to-Text docs (June 2026)**, but
the official docs page blocked automated fetching, so I confirmed details via
ElevenLabs' search results / cheat sheet rather than reading the page directly.
Specifically, please sanity-check these once when you set up your key:

1. **Model id.** I default to **`scribe_v2`** because **`scribe_v1` is
   deprecated and scheduled for removal on 2026‑07‑09**. If ElevenLabs has
   renamed the current model, set `ELEVENLABS_MODEL_ID` in Cloudflare to the
   correct id — no code change needed. The `/api/transcribe` GET health route
   shows which model id is active.
2. **Field names.** The request uses multipart fields **`file`**,
   **`model_id`**, and **`language_code`** (Croatian = `hr`), with auth header
   **`xi-api-key`**, against **`POST https://api.elevenlabs.io/v1/speech-to-text`**.
   These match the docs as of writing; if a future API version changes a field
   name, it's a one-line edit in `functions/api/transcribe.ts`.
3. **Cloudflare Pages UI labels** occasionally get renamed (e.g. "Environment
   variables" → "Variables and Secrets"). The **locations** (Project → Settings)
   are stable; menu wording may differ slightly from the screenshots in your
   dashboard.

Everything else (same-origin proxy, no-CORS design, PWA install, share target,
localStorage history) is implemented and was exercised locally against the real
Cloudflare Pages runtime via `wrangler pages dev`.
