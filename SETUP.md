# Glas — Setup, from empty to live

This guide takes you from **nothing** to a **live `*.workers.dev` URL** that
transcribes Croatian voice notes, then installs it on Android so you can share
WhatsApp voice messages straight into it.

**You need three free things:**
- A **GitHub** account
- A **Cloudflare** account (free plan is enough)
- An **ElevenLabs** account with an **API key** (Profile → API Keys)

The **Cloudflare dashboard** is the primary path. Optional `wrangler` CLI steps
are in the boxes marked *CLI alternative*.

> Everything runs on **one** Cloudflare Worker: it serves the static frontend
> from `public/` **and** the `/api/transcribe` backend (`src/index.ts`). Because
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

Refresh the GitHub page — you should see `src/`, `public/`, `wrangler.toml`, `SETUP.md`, etc.

> 🔒 **Sanity check:** open `.env.example` on GitHub — it should contain only the
> placeholder `your_elevenlabs_api_key_here`, never your real key. Your real key
> goes into Cloudflare in step 3, not into the repo.

---

## 2. Create the Cloudflare project & connect GitHub

> Cloudflare has unified Workers & Pages. New accounts only get the **Workers**
> "Import a repository" flow (no separate Pages tab). This project is built to
> deploy that way — a single Worker that serves the static frontend from
> `public/` **and** handles `/api/transcribe` (see `src/index.ts` +
> `wrangler.toml`). Use the **default** deploy command; don't change it to
> `wrangler pages deploy`.

1. Sign in at <https://dash.cloudflare.com>.
2. In the left sidebar click **Workers & Pages**.
3. Click **Create** → **Import a repository** (Workers) → connect GitHub →
   choose **Only select repositories** → pick `Voice-transcriber` →
   **Install & Authorize**.
4. Select the repo. Cloudflare reads `wrangler.toml`, so the defaults are right:

| Field | Value |
|---|---|
| **Project / Worker name** | `glas` |
| **Production branch** | `main` |
| **Build command** | *(leave empty — no build step)* |
| **Deploy command** | **`npx wrangler deploy`** (the default — leave it) |
| **Non-production branch deploy command** | `npx wrangler versions upload` (default) |
| **API token** | **Create new token** (let Cloudflare auto-generate it) |

⚠️ **Do not** set the deploy command to `npx wrangler pages deploy …` — the
auto-generated token is Workers-scoped, so a `pages deploy` fails with
`Authentication error [code: 10000]`. The default `npx wrangler deploy` works
because `wrangler.toml` declares `main = "src/index.ts"` and an `[assets]`
binding pointing at `public/`.

Don't click the final deploy yet — **add the secret first** (next step) so the
very first deploy already has the key. (If you deploy first, that's fine too;
just redeploy after adding the variables.)

> **CLI alternative (instead of the dashboard):**
> ```bash
> npm install
> npx wrangler login
> npx wrangler secret put ELEVENLABS_API_KEY      # paste key when prompted
> npx wrangler deploy                             # reads wrangler.toml
> ```
> Connecting the GitHub repo in the dashboard is still recommended so you get
> auto-deploy on push.

---

## 3. Add the API key (and EU host if needed) as variables

This is the **only** place your real key lives.

1. Open your project: **Workers & Pages → `glas`**.
2. Go to the **Settings** tab → **Variables and Secrets** (older UIs:
   **Environment variables**).
3. Click **+ Add** and create these:

| Name | Value | Type |
|---|---|---|
| `ELEVENLABS_API_KEY` | your real key (`sk_…`) | **Secret / Encrypt** |
| `ELEVENLABS_BASE_URL` | `https://api.eu.residency.elevenlabs.io` | plain (or Secret) — **only if your ElevenLabs account uses EU data residency** |

4. **Environment:** add each for **Production**, then again for **Preview** (or
   use "apply to all environments" if shown) — otherwise preview deploys won't
   transcribe.
5. Click **Save**.

> ⚠️ **EU accounts:** an EU-residency API key works **only** against the EU host.
> If you leave `ELEVENLABS_BASE_URL` unset, the app uses the global host
> `https://api.elevenlabs.io` and an EU key will fail (typically HTTP 401/403).
> If your account is *not* EU, skip this variable.

> If you added variables **after** the first deploy, trigger a fresh deploy so
> they're picked up: **Deployments → … → Retry deployment**, or just push a commit.

Optional extra variables (defaults are baked in, so you normally add nothing):
- `ELEVENLABS_MODEL_ID` — defaults to `scribe_v2`.
- `ELEVENLABS_LANGUAGE_CODE` — defaults to `hr` (Croatian).

> **CLI alternative:** `npx wrangler secret put ELEVENLABS_API_KEY`, and for the
> base URL `npx wrangler secret put ELEVENLABS_BASE_URL` (or add it as a `[vars]`
> entry in `wrangler.toml`).

---

## 4. Confirm the `/api/transcribe` route is live

1. Click **Save and Deploy** (or **Deployments → Retry** if you deployed earlier).
2. Wait for the build/deploy to go **Success** (usually well under a minute). The
   log should show `npx wrangler deploy` uploading your Worker + assets.
3. To confirm the API: open **`https://<your-worker>.workers.dev/api/transcribe`**
   (or your custom `*.pages.dev`/domain) in a browser — a plain **GET**. You
   should see JSON like:

   ```json
   { "ok": true, "route": "/api/transcribe",
     "model_id": "scribe_v2", "language_code": "hr",
     "base_url": "https://api.eu.residency.elevenlabs.io",
     "key_configured": true }
   ```

   - `key_configured: true` ✅ — your secret is wired up.
   - `base_url` shows EU ✅ — your EU host variable is active (if you set it).
   - `key_configured: false` ❌ — the variable isn't set for this environment;
     go back to step 3 and redeploy.

---

## 5. First deploy & finding your live URL

1. In your project, open the **Deployments** (or **Metrics/Settings**) tab.
2. The live URL is shown near the top — a Worker uses
   **`https://glas.<your-subdomain>.workers.dev`**. Click it. (You can also add a
   custom domain later under **Settings → Domains & Routes**.)
3. The app loads. Tap the drop zone, pick a Croatian `.opus`/`.m4a`/`.mp3`,
   tap **Transcribe Croatian**, and you should get Croatian text with a **Copy**
   button. 🎉

Each branch push also produces a **preview version** URL — handy for testing
before it's promoted to production.

---

## 6. Install the PWA on Android & use the Share Target

### Install
1. On your Android phone, open **Chrome** and visit your `*.workers.dev` URL.
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
- Cloudflare Workers Builds watches your GitHub repo. **Every push to `main`
  auto-builds and deploys to production.** Pushes to other branches create
  **preview versions**. No GitHub Actions, no extra config.
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

**"Transcription failed (HTTP 401/403)" / invalid key.**
Either the key is wrong/revoked, **or** there's a region mismatch: an EU
data-residency key only works against the EU host. Re-copy the key from
ElevenLabs → **Profile → API Keys**, and make sure `ELEVENLABS_BASE_URL` is set
to `https://api.eu.residency.elevenlabs.io` for EU accounts (check the `base_url`
field in the step-4 health JSON). Update the variable, then redeploy.

**Deploy fails with `Authentication error [code: 10000]`.**
The deploy command was changed to `npx wrangler pages deploy …`, but the
auto-generated token is Workers-scoped. Set the **Deploy command** back to the
default **`npx wrangler deploy`** (Settings → **Builds** → edit) and redeploy.

**The page loads but assets are missing / 404s, or `/api/transcribe` 404s.**
Check `wrangler.toml`: it must have `main = "src/index.ts"` and an `[assets]`
block with `directory = "./public"` and `binding = "ASSETS"`. The deploy command
must be `npx wrangler deploy`. Save and redeploy.

**Share Target (Glas) doesn't appear in WhatsApp's share sheet.**
- You must **install the PWA first** (step 6) — the target only registers once
  installed, and only on Android Chrome (not iOS).
- Open the installed Glas app once after installing.
- Make sure you're sharing the **audio file** (long-press the voice message →
  three-dot **Share**), not forwarding the chat as text.
- If it still doesn't show, uninstall and reinstall the PWA to refresh the
  manifest, and confirm the site is served over **HTTPS** (workers.dev always is).

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
   **`xi-api-key`**, against **`POST {base}/v1/speech-to-text`**. These match the
   docs as of writing; if a future API version changes a field name, it's a
   one-line edit in `src/index.ts`.
3. **Cloudflare UI labels** occasionally get renamed (e.g. "Environment
   variables" → "Variables and Secrets"; the unified "Import a repository"
   Workers flow). The **locations** (Project → Settings) are stable; menu wording
   may differ slightly from this guide.

Everything else (same-origin proxy, no-CORS design, PWA install, share target,
localStorage history) is implemented and was exercised locally against the real
Workers runtime via `wrangler dev`.
