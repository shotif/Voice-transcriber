/**
 * Glas — Cloudflare Worker (Static Assets + API).
 *
 * Cloudflare unified Workers & Pages: this project deploys as a single Worker
 * that serves the static frontend from the `public/` directory (via the ASSETS
 * binding) and handles the same-origin API route POST /api/transcribe.
 *
 * The Worker forwards the uploaded audio to ElevenLabs Scribe with the secret
 * API key — which lives ONLY as a Worker secret/variable, never in the client
 * bundle — and returns the Croatian transcript.
 *
 * ElevenLabs request shape (verified against the current docs, June 2026):
 *   POST {ELEVENLABS_BASE_URL}/v1/speech-to-text
 *   Header: xi-api-key: <ELEVENLABS_API_KEY>
 *   multipart/form-data fields:
 *     file          -> the audio (required)
 *     model_id      -> required. scribe_v1 is deprecated (removed 2026-07-09),
 *                      so we default to scribe_v2.
 *     language_code -> ISO-639-1/3 code. Croatian = "hr". Forces the language.
 */

interface Env {
  ASSETS: Fetcher; // static assets binding (the `public/` directory)
  ELEVENLABS_API_KEY: string;
  // Optional shared access code. If set, callers must send it as the
  // `x-app-passcode` header or transcription is rejected (401). Leave unset to
  // keep the endpoint open. Set it as a Secret in the dashboard to lock down.
  APP_PASSCODE?: string;
  // Optional admin log. When BOTH a D1 binding named DB and an ADMIN_PASSWORD
  // secret are present, every successful transcription is stored in D1 and the
  // owner can review them at /admin. Absent → no logging, /admin returns 503.
  DB?: D1Database;
  ADMIN_PASSWORD?: string;
  // Optional AI summary. When ANTHROPIC_API_KEY is set, POST /api/summarize
  // turns a transcript into a short Croatian summary via the Claude API.
  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_MODEL?: string; // override the summary model (default below)
  // Max successful transcriptions per device per 24h (default 50). Needs DB.
  RATE_LIMIT_PER_DAY?: string;
  // Optional overrides (set in the dashboard under Settings > Variables):
  ELEVENLABS_MODEL_ID?: string;
  ELEVENLABS_LANGUAGE_CODE?: string;
  // Base API host. Use the EU data-residency host for EU accounts:
  //   https://api.eu.residency.elevenlabs.io
  // Defaults to the global host. NOTE: an EU-residency API key only works
  // against the EU host, so set this if your ElevenLabs account is EU.
  ELEVENLABS_BASE_URL?: string;
}

const DEFAULT_BASE_URL = "https://api.elevenlabs.io";
const DEFAULT_MODEL_ID = "scribe_v2";
const DEFAULT_LANGUAGE_CODE = "hr"; // Croatian
const MAX_BYTES = 100 * 1024 * 1024; // 100 MB guardrail; voice notes are tiny

// Claude API for summaries (single message call; verified June 2026).
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_SUMMARY_MODEL = "claude-sonnet-4-6";
const MAX_SUMMARY_CHARS = 100_000; // guardrail on transcript size sent to Claude
const DEFAULT_RATE_LIMIT = 50; // successful transcriptions / device / 24h

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

// Length-constant string compare, to avoid leaking the passcode via timing.
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/transcribe") {
      if (request.method === "POST") return handleTranscribe(request, env, ctx);
      if (request.method === "GET") return handleHealth(env);
      return json({ error: "Method not allowed." }, 405);
    }

    if (
      (url.pathname === "/api/ai" || url.pathname === "/api/summarize") &&
      request.method === "POST"
    )
      return handleAi(request, env, ctx);

    // Admin log (owner-only; requires D1 binding DB + ADMIN_PASSWORD secret).
    if (url.pathname === "/api/admin/list" && request.method === "GET")
      return handleAdminList(request, env);
    if (url.pathname === "/api/admin/clear" && request.method === "POST")
      return handleAdminClear(request, env);
    if (url.pathname === "/admin")
      return new Response(ADMIN_HTML, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });

    // Everything else is a static asset (index.html, app.js, sw.js, icons, …).
    return env.ASSETS.fetch(request);
  },
};

function handleHealth(env: Env): Response {
  return json({
    ok: true,
    route: "/api/transcribe",
    api_version: "ai+archive+timestamps", // canary: confirms latest deploy
    accepts: "multipart 'file' field OR raw audio body; ?format=text for plain text",
    method: "POST multipart/form-data (field: file)",
    model_id: env.ELEVENLABS_MODEL_ID || DEFAULT_MODEL_ID,
    language_code: env.ELEVENLABS_LANGUAGE_CODE || DEFAULT_LANGUAGE_CODE,
    base_url: (env.ELEVENLABS_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, ""),
    key_configured: Boolean(env.ELEVENLABS_API_KEY),
    passcode_required: Boolean(env.APP_PASSCODE),
    summarize_enabled: Boolean(env.ANTHROPIC_API_KEY),
    summary_model: env.ANTHROPIC_MODEL || DEFAULT_SUMMARY_MODEL,
    rate_limit_per_day: env.DB ? rateLimitPerDay(env) : null,
    db_bound: Boolean(env.DB),
    admin_password_set: Boolean(env.ADMIN_PASSWORD),
    admin_enabled: Boolean(env.DB && env.ADMIN_PASSWORD),
  });
}

async function handleTranscribe(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const res = await transcribeToJSON(request, env, ctx);

  // Plain-text mode for the iOS Shortcut: `?format=text` (or Accept: text/plain)
  // returns just the transcript as text/plain, so the Shortcut needs no JSON
  // parsing — it copies the body straight to the clipboard.
  const wantsText =
    new URL(request.url).searchParams.get("format") === "text" ||
    (request.headers.get("accept") || "").includes("text/plain");
  if (!wantsText) return res;

  let data: any = {};
  try {
    data = await res.clone().json();
  } catch {
    /* ignore */
  }
  const body = res.ok ? (data.text ?? "") : (data.error ?? `Error ${res.status}`);
  return new Response(body, {
    status: res.status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

async function transcribeToJSON(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  // Shared access gate. When APP_PASSCODE is set, reject callers without the
  // matching x-app-passcode header before doing any work or touching the key.
  if (env.APP_PASSCODE) {
    const provided = request.headers.get("x-app-passcode") || "";
    if (!safeEqual(provided, env.APP_PASSCODE)) {
      return json(
        { error: "Wrong or missing access code.", code: "passcode" },
        401,
      );
    }
  }

  if (!env.ELEVENLABS_API_KEY) {
    return json(
      {
        error:
          "Server is missing ELEVENLABS_API_KEY. Add it under the project's Settings > Variables and Secrets, then redeploy.",
      },
      500,
    );
  }

  // Per-device daily rate limit (protects the ElevenLabs + Claude keys from
  // abuse). Counts this caller's successful transcriptions in the last 24h.
  if (await overRateLimit(request, env)) {
    return json(
      {
        error: `Dnevni limit prijepisa je dosegnut (${rateLimitPerDay(env)}/24h). Pokušaj ponovno kasnije.`,
        code: "rate_limit",
      },
      429,
    );
  }

  // Accept the audio two ways:
  //  a) multipart/form-data with a `file` field  — used by the web app.
  //  b) a raw audio request body                 — used by the iOS Shortcut,
  //     which just POSTs the shared file's bytes (Content-Type = the audio type,
  //     optional X-Filename header). This keeps the Shortcut dead simple.
  const contentType = request.headers.get("content-type") || "";
  let file: File;

  if (contentType.includes("multipart/form-data")) {
    let inbound: FormData;
    try {
      inbound = await request.formData();
    } catch {
      return json(
        {
          error:
            "Couldn't read the audio. In the iOS Shortcut set Request Body to 'File' (= Shortcut Input), and share an actual voice note rather than running it empty.",
        },
        400,
      );
    }
    let f: FormDataEntryValue | null = inbound.get("file") ?? inbound.get("audio");
    // Be tolerant of any field name: take the first File-valued field.
    if (!(f instanceof File)) {
      inbound.forEach((v) => {
        if (!(f instanceof File) && v instanceof File) f = v;
      });
    }
    if (!(f instanceof File)) {
      return json({ error: "No audio file found in the request." }, 400);
    }
    file = f;
  } else {
    const buf = await request.arrayBuffer();
    if (!buf || buf.byteLength === 0) {
      return json({ error: "The request body was empty (no audio)." }, 400);
    }
    const name =
      safeDecode(request.headers.get("x-filename")) ||
      `voice-note${extForType(contentType)}`;
    file = new File([buf], name, {
      type: contentType || "application/octet-stream",
    });
  }

  if (file.size === 0) {
    return json({ error: "The uploaded audio file is empty." }, 400);
  }
  if (file.size > MAX_BYTES) {
    return json({ error: "Audio file is too large (max 100 MB)." }, 413);
  }

  const modelId = env.ELEVENLABS_MODEL_ID || DEFAULT_MODEL_ID;
  const languageCode = env.ELEVENLABS_LANGUAGE_CODE || DEFAULT_LANGUAGE_CODE;
  const baseUrl = (env.ELEVENLABS_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const elevenUrl = `${baseUrl}/v1/speech-to-text`;

  const outbound = new FormData();
  // WhatsApp .opus blobs sometimes arrive with a generic type; give ElevenLabs
  // a filename so it can sniff the container.
  const filename = file.name || "voice-note.ogg";
  outbound.set("file", file, filename);
  outbound.set("model_id", modelId);
  outbound.set("language_code", languageCode);

  let elevenRes: Response;
  try {
    elevenRes = await fetch(elevenUrl, {
      method: "POST",
      headers: { "xi-api-key": env.ELEVENLABS_API_KEY },
      body: outbound,
    });
  } catch {
    return json(
      { error: "Could not reach the transcription service. Try again." },
      502,
    );
  }

  if (!elevenRes.ok) {
    // Surface a readable message without leaking internals.
    let detail = "";
    try {
      const body: any = await elevenRes.json();
      detail =
        body?.detail?.message ||
        (typeof body?.detail === "string" ? body.detail : "") ||
        body?.message ||
        "";
    } catch {
      try {
        detail = await elevenRes.text();
      } catch {
        /* ignore */
      }
    }
    const hint =
      elevenRes.status === 401
        ? "The ELEVENLABS_API_KEY appears to be invalid."
        : elevenRes.status === 403
          ? "Check the key and that ELEVENLABS_BASE_URL matches your account region (EU vs global)."
          : elevenRes.status === 422
            ? "The audio format may be unsupported or corrupted."
            : "";
    return json(
      {
        error:
          `Transcription failed (HTTP ${elevenRes.status}). ${hint} ${detail}`.trim(),
      },
      elevenRes.status === 401 ? 502 : elevenRes.status,
    );
  }

  let result: any;
  try {
    result = await elevenRes.json();
  } catch {
    return json(
      { error: "Transcription service returned an unexpected response." },
      502,
    );
  }

  const text: string = (result?.text ?? "").trim();
  const lang: string = result?.language_code ?? languageCode;

  // Owner-only admin log. Fire-and-forget so it never delays/breaks the reply.
  if (env.DB && text) {
    const label =
      safeDecode(request.headers.get("x-user-label")).slice(0, 60) || "—";
    const deviceId = (request.headers.get("x-device-id") || "").slice(0, 64);
    const secRaw = parseFloat(request.headers.get("x-audio-seconds") || "");
    const seconds = Number.isFinite(secRaw) && secRaw > 0 ? secRaw : null;
    ctx.waitUntil(
      logTranscript(env, { label, filename, lang, text, deviceId, seconds }),
    );
    ctx.waitUntil(logUsage(env, { deviceId, label, kind: "transcribe" }));
  }

  // Word-level timestamps (Scribe `words`: {text, start, end, type}). Keep only
  // real words with numeric times, compacted to {t,s,e}, for click-to-seek.
  const words = Array.isArray(result?.words)
    ? result.words
        .filter((w: any) => w?.type === "word" && typeof w?.start === "number")
        .map((w: any) => ({ t: String(w.text ?? ""), s: w.start, e: w.end }))
    : [];

  return json({
    text,
    language_code: lang,
    language_probability: result?.language_probability ?? null,
    model_id: modelId,
    words,
  });
}

// ---------- AI text tools (Claude API) ----------
const SUMMARY_SYSTEM =
  "Ti si pomoćnik koji sažima glasovne poruke na hrvatskom. Korisnik ti daje " +
  "prijepis (transkript) glasovne poruke. Odgovori ISKLJUČIVO na hrvatskom, " +
  "jezgrovito i bez uvoda. Format:\n" +
  "1) Jedna rečenica sažetka.\n" +
  "2) Ključne točke kao kratki bulleti (•).\n" +
  "3) Ako postoje, odvojeno navedi 'Zadaci/akcije:' kao bullete; ako ih nema, izostavi taj dio.\n" +
  "Ne izmišljaj sadržaj koji nije u prijepisu.";

type AiTask = "summary" | "cleanup" | "translate" | "actions" | "ask" | "title";

// Build the Claude system + user content for a given task. Returns an error
// string when the task's inputs are invalid.
function buildAi(
  task: AiTask,
  body: { text: string; lang?: string; question?: string },
): { system: string; user: string; maxTokens: number } | { error: string } {
  const text = body.text;
  switch (task) {
    case "summary":
      return { system: SUMMARY_SYSTEM, user: text, maxTokens: 1024 };
    case "cleanup":
      return {
        system:
          "Uredi i formatiraj sljedeći transkript na hrvatskom: ispravi interpunkciju i velika slova, " +
          "podijeli u logične odlomke, ukloni poštapalice (npr. ovaj, znači, kao) i ponavljanja. " +
          "NEMOJ mijenjati značenje niti dodavati sadržaj. Vrati samo sređeni tekst, bez uvoda.",
        user: text,
        maxTokens: 2048,
      };
    case "translate": {
      const lang = (body.lang || "engleski").slice(0, 40);
      return {
        system: `Prevedi sljedeći tekst na ${lang}. Vrati isključivo prijevod, bez komentara i bez originala.`,
        user: text,
        maxTokens: 2048,
      };
    }
    case "actions":
      return {
        system:
          "Iz sljedećeg transkripta izvuci, na hrvatskom, samo ono što stvarno postoji:\n" +
          "'Zadaci:' (• obaveze/akcije, s vremenom ako je navedeno)\n" +
          "'Datumi i vrijeme:' (• spomenuti termini)\n" +
          "'Kontakti:' (• imena, telefoni, e-mailovi)\n" +
          "Izostavi prazne sekcije. Ako nema ničega od navedenog, napiši: 'Nema zadataka, datuma ni kontakata.'",
        user: text,
        maxTokens: 1024,
      };
    case "ask": {
      const q = (body.question || "").trim();
      if (!q) return { error: "Nedostaje pitanje." };
      return {
        system:
          "Odgovori na korisnikovo pitanje ISKLJUČIVO na temelju danog transkripta, na hrvatskom. " +
          "Ako odgovor nije u transkriptu, reci: 'To nije spomenuto u poruci.'",
        user: `Transkript:\n${text}\n\nPitanje: ${q}`,
        maxTokens: 1024,
      };
    }
    case "title":
      return {
        system:
          "Vrati vrlo kratak naslov (3 do 6 riječi) na hrvatskom za ovaj prijepis. " +
          "Vrati samo naslov, bez navodnika i bez interpunkcije na kraju.",
        user: text.slice(0, 4000),
        maxTokens: 32,
      };
    default:
      return { error: "Nepoznata radnja." };
  }
}

// Single Claude Messages call. Returns the joined text, or an error shape.
async function callClaude(
  env: Env,
  system: string,
  user: string,
  maxTokens: number,
): Promise<{ text: string } | { error: string; status: number }> {
  const model = env.ANTHROPIC_MODEL || DEFAULT_SUMMARY_MODEL;
  let res: Response;
  try {
    res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "x-api-key": env.ANTHROPIC_API_KEY!,
        "anthropic-version": ANTHROPIC_VERSION,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: "user", content: user }],
      }),
    });
  } catch {
    return { error: "Could not reach the AI service. Try again.", status: 502 };
  }
  if (!res.ok) {
    let detail = "";
    try {
      detail = ((await res.json()) as any)?.error?.message || "";
    } catch {
      /* ignore */
    }
    const hint = res.status === 401 ? "The ANTHROPIC_API_KEY appears invalid." : "";
    return {
      error: `AI request failed (HTTP ${res.status}). ${hint} ${detail}`.trim(),
      status: res.status === 401 ? 502 : res.status,
    };
  }
  let data: any;
  try {
    data = await res.json();
  } catch {
    return { error: "AI service returned an unexpected response.", status: 502 };
  }
  const text: string = Array.isArray(data?.content)
    ? data.content
        .filter((b: any) => b?.type === "text" && typeof b.text === "string")
        .map((b: any) => b.text)
        .join("\n")
        .trim()
    : "";
  if (!text) return { error: "AI je vratio prazan odgovor.", status: 502 };
  return { text };
}

async function handleAi(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);
  const wantsText =
    url.searchParams.get("format") === "text" ||
    (request.headers.get("accept") || "").includes("text/plain");
  const out = (result: string, task?: AiTask, errorStatus?: number, errorMsg?: string) => {
    if (wantsText) {
      return new Response(errorMsg ?? result, {
        status: errorStatus ?? 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    if (errorMsg) return json({ error: errorMsg }, errorStatus ?? 500);
    // `summary` alias kept for older clients that read data.summary.
    return json(task === "summary" ? { result, summary: result } : { result });
  };

  if (env.APP_PASSCODE) {
    const provided = request.headers.get("x-app-passcode") || "";
    if (!safeEqual(provided, env.APP_PASSCODE)) {
      return out("", undefined, 401, "Wrong or missing access code.");
    }
  }
  if (!env.ANTHROPIC_API_KEY) {
    return out("", undefined, 503, "AI nije konfiguriran (postavi ANTHROPIC_API_KEY).");
  }

  let body: any = {};
  try {
    body = await request.json();
  } catch {
    return out("", undefined, 400, "Expected JSON body.");
  }
  // /api/summarize (no task) defaults to summary for backward compatibility.
  const task = (body?.task || url.searchParams.get("task") || "summary") as AiTask;

  // Auto-titles are tiny and fire automatically per transcription, so they're
  // exempt from the shared daily cap (and not logged as usage). Everything else
  // counts toward the cap.
  if (task !== "title" && (await overRateLimit(request, env))) {
    return out("", undefined, 429, `Dnevni limit je dosegnut (${rateLimitPerDay(env)}/24h). Pokušaj kasnije.`);
  }
  let text = typeof body?.text === "string" ? body.text.trim() : "";
  if (!text) return out("", task, 400, "Nema teksta za obradu.");
  if (text.length > MAX_SUMMARY_CHARS) text = text.slice(0, MAX_SUMMARY_CHARS);

  const built = buildAi(task, { text, lang: body?.lang, question: body?.question });
  if ("error" in built) return out("", task, 400, built.error);

  const r = await callClaude(env, built.system, built.user, built.maxTokens);
  if ("error" in r) return out("", task, r.status, r.error);

  // Count this AI call toward the shared daily cap (titles are exempt).
  if (env.DB && task !== "title") {
    const deviceId = (request.headers.get("x-device-id") || "").slice(0, 64);
    const label = safeDecode(request.headers.get("x-user-label")).slice(0, 60) || "—";
    ctx.waitUntil(logUsage(env, { deviceId, label, kind: "ai:" + task }));
  }
  return out(r.text, task);
}

// ---------- admin log (D1) ----------
const SCHEMA =
  "CREATE TABLE IF NOT EXISTS transcripts (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at INTEGER NOT NULL, user_label TEXT, filename TEXT, lang TEXT, chars INTEGER, text TEXT)";

const USAGE_SCHEMA =
  "CREATE TABLE IF NOT EXISTS usage (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at INTEGER NOT NULL, device_id TEXT, user_label TEXT, kind TEXT)";

// Create the table and add later columns. ALTER on an existing column throws
// ("duplicate column name") — ignored, so this is a safe idempotent migration.
async function ensureSchema(db: D1Database): Promise<void> {
  await db.prepare(SCHEMA).run();
  await db.prepare(USAGE_SCHEMA).run();
  for (const col of ["device_id TEXT", "seconds REAL"]) {
    try {
      await db.prepare(`ALTER TABLE transcripts ADD COLUMN ${col}`).run();
    } catch {
      /* column already exists */
    }
  }
}

// Records one billable action (transcription or AI call) for the shared daily
// rate limit. Best-effort: never breaks the request.
async function logUsage(
  env: Env,
  e: { deviceId: string; label: string; kind: string },
): Promise<void> {
  try {
    await ensureSchema(env.DB!);
    await env.DB!.prepare(
      "INSERT INTO usage (created_at, device_id, user_label, kind) VALUES (?, ?, ?, ?)",
    )
      .bind(Date.now(), e.deviceId || null, e.label || null, e.kind)
      .run();
  } catch {
    /* usage logging must never break the request */
  }
}

function safeDecode(v: string | null): string {
  if (!v) return "";
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}

// Best-effort file extension from a content-type, so ElevenLabs can sniff the
// container when the iOS Shortcut posts a raw body.
function extForType(ct: string): string {
  const t = ct.toLowerCase();
  if (t.includes("ogg") || t.includes("opus")) return ".ogg";
  if (t.includes("mpeg") || t.includes("mp3")) return ".mp3";
  if (t.includes("mp4") || t.includes("m4a") || t.includes("aac")) return ".m4a";
  if (t.includes("wav")) return ".wav";
  if (t.includes("webm")) return ".webm";
  if (t.includes("flac")) return ".flac";
  return ".audio";
}

async function logTranscript(
  env: Env,
  e: {
    label: string;
    filename: string;
    lang: string;
    text: string;
    deviceId: string;
    seconds: number | null;
  },
): Promise<void> {
  try {
    await ensureSchema(env.DB!);
    await env
      .DB!.prepare(
        "INSERT INTO transcripts (created_at, user_label, filename, lang, chars, text, device_id, seconds) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        Date.now(),
        e.label,
        e.filename,
        e.lang,
        e.text.length,
        e.text,
        e.deviceId || null,
        e.seconds,
      )
      .run();
  } catch {
    /* logging must never break transcription */
  }
}

function rateLimitPerDay(env: Env): number {
  const n = parseInt(env.RATE_LIMIT_PER_DAY || "", 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_RATE_LIMIT;
}

// Returns true if this caller has hit the daily transcription cap. Counts are
// read from the D1 log; without DB there is no store, so no limit is enforced.
async function overRateLimit(request: Request, env: Env): Promise<boolean> {
  if (!env.DB) return false;
  const deviceId = (request.headers.get("x-device-id") || "").slice(0, 64);
  const label = safeDecode(request.headers.get("x-user-label")).slice(0, 60);
  // Identify by device id (web) or, failing that, the device name (iOS Shortcut).
  let column: "device_id" | "user_label";
  let value: string;
  if (deviceId) {
    column = "device_id";
    value = deviceId;
  } else if (label && label !== "—") {
    column = "user_label";
    value = label;
  } else {
    return false; // can't identify the caller — passcode still gates access
  }
  try {
    await ensureSchema(env.DB);
    const since = Date.now() - 24 * 60 * 60 * 1000;
    // Count BOTH transcriptions and AI calls (the shared daily cap).
    const row = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM usage WHERE ${column} = ? AND created_at > ?`,
    )
      .bind(value, since)
      .first<{ n: number }>();
    return (row?.n ?? 0) >= rateLimitPerDay(env);
  } catch {
    return false; // never block on a logging/DB hiccup
  }
}

function adminGate(request: Request, env: Env): Response | null {
  if (!env.DB || !env.ADMIN_PASSWORD) {
    return json(
      {
        error:
          "Admin is not configured. Add a D1 binding named DB and an ADMIN_PASSWORD secret.",
        code: "unconfigured",
      },
      503,
    );
  }
  const provided = request.headers.get("x-admin-password") || "";
  if (!safeEqual(provided, env.ADMIN_PASSWORD)) {
    return json({ error: "Unauthorized.", code: "admin" }, 401);
  }
  return null;
}

async function handleAdminList(request: Request, env: Env): Promise<Response> {
  const gate = adminGate(request, env);
  if (gate) return gate;
  try {
    await ensureSchema(env.DB!);
    const { results } = await env
      .DB!.prepare(
        "SELECT id, created_at, user_label, filename, lang, chars, text, device_id, seconds FROM transcripts ORDER BY id DESC LIMIT 500",
      )
      .all();
    return json({ transcripts: results ?? [] });
  } catch {
    return json({ error: "Could not read the transcript log." }, 500);
  }
}

async function handleAdminClear(request: Request, env: Env): Promise<Response> {
  const gate = adminGate(request, env);
  if (gate) return gate;
  try {
    await env.DB!.prepare("DELETE FROM transcripts").run();
    return json({ ok: true });
  } catch {
    return json({ error: "Could not clear the transcript log." }, 500);
  }
}

// ---------- admin page (served at /admin) ----------
// Self-contained HTML. Renders transcript text via textContent (never innerHTML)
// so logged content can't inject markup. Auth is a password kept in
// sessionStorage and sent as the x-admin-password header.
const ADMIN_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>Glas — Admin</title>
<style>
  :root{--bg:#0f1020;--card:#1c1d33;--card2:#232544;--text:#ececf5;--muted:#a0a2c0;--primary:#6366f1;--danger:#ef4444;--line:#2b2d4d}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif}
  .wrap{max-width:820px;margin:0 auto;padding:20px 16px 60px}
  h1{font-size:1.4rem;margin:0 0 2px}
  .sub{color:var(--muted);font-size:.85rem;margin:0 0 18px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px;margin-bottom:12px}
  input{width:100%;padding:13px 14px;border-radius:10px;border:1px solid #3a3c63;background:#16172b;color:var(--text);font-size:1rem;margin-bottom:10px}
  button{border:0;border-radius:10px;padding:11px 16px;font-weight:700;color:#fff;background:var(--primary);cursor:pointer;font-size:.95rem}
  button.ghost{background:var(--card2);border:1px solid var(--line)}
  button.danger{background:var(--danger)}
  .row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:14px}
  .grow{flex:1}
  .item{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px;margin-bottom:10px}
  .meta{display:flex;justify-content:space-between;gap:10px;font-size:.8rem;color:var(--muted);margin-bottom:8px;flex-wrap:wrap}
  .who{color:#c7c9ee;font-weight:700}
  .txt{white-space:pre-wrap;word-break:break-word;line-height:1.55;margin:0}
  .err{color:#fecaca;font-size:.9rem;margin:6px 0 0}
  .muted{color:var(--muted)}
  .count{font-size:.85rem;color:var(--muted)}
  .hidden{display:none}
</style>
</head>
<body>
<div class="wrap">
  <h1>Glas — Admin</h1>
  <p class="sub">Owner-only transcript log. Keep this page and password private.</p>

  <div id="login" class="card">
    <input id="pw" type="password" placeholder="Admin password" autocomplete="current-password" />
    <button id="loginBtn">Sign in</button>
    <p id="loginErr" class="err hidden"></p>
  </div>

  <div id="panel" class="hidden">
    <div class="row">
      <input id="filter" class="grow" type="text" placeholder="Filter by text, name or filename…" style="margin:0" />
      <button id="refresh" class="ghost">Refresh</button>
      <button id="logout" class="ghost">Log out</button>
      <button id="clear" class="danger">Clear all</button>
    </div>
    <p id="count" class="count"></p>
    <p id="panelErr" class="err hidden"></p>
    <div id="usage" class="card"></div>
    <div id="list"></div>
  </div>
</div>
<script>
  var KEY = "glas-admin-pw";
  var all = [];
  function $(id){return document.getElementById(id)}
  function pw(){try{return sessionStorage.getItem(KEY)||""}catch(e){return ""}}
  function setPw(v){try{v?sessionStorage.setItem(KEY,v):sessionStorage.removeItem(KEY)}catch(e){}}
  function fmt(ts){try{return new Date(ts).toLocaleString()}catch(e){return ""+ts}}

  function show(authed){
    $("login").classList.toggle("hidden",authed);
    $("panel").classList.toggle("hidden",!authed);
  }
  function whoKey(r){
    var label=(r.user_label||"").trim();
    if(label && label!=="—") return label;
    if(r.device_id) return "uređaj " + String(r.device_id).slice(0,8);
    return "nepoznato";
  }
  function renderUsage(rows){
    var box=$("usage");box.innerHTML="";
    var by={};
    rows.forEach(function(r){
      var k=whoKey(r);
      if(!by[k]) by[k]={count:0,chars:0,seconds:0,last:0};
      by[k].count++; by[k].chars+=(r.chars||0); by[k].seconds+=(r.seconds||0);
      if(r.created_at>by[k].last) by[k].last=r.created_at;
    });
    var keys=Object.keys(by).sort(function(a,b){return by[b].count-by[a].count});
    var title=document.createElement("div");title.className="who";title.style.marginBottom="8px";
    title.textContent="Potrošnja po korisniku/uređaju";box.appendChild(title);
    if(!keys.length){var none=document.createElement("p");none.className="muted";none.textContent="Nema podataka.";box.appendChild(none);return}
    keys.forEach(function(k){
      var u=by[k];
      var line=document.createElement("div");line.className="meta";line.style.marginBottom="6px";
      var l=document.createElement("span");var who=document.createElement("span");who.className="who";who.textContent=k;
      l.appendChild(who);
      var det=document.createElement("span");det.className="muted";
      var mins=u.seconds?("  ·  "+(u.seconds/60).toFixed(1)+" min"):"";
      det.textContent="  ·  "+u.count+" prijepisa  ·  "+u.chars+" znakova"+mins;
      l.appendChild(det);
      var t=document.createElement("span");t.textContent=fmt(u.last);
      line.appendChild(l);line.appendChild(t);box.appendChild(line);
    });
  }
  function render(){
    var q=$("filter").value.trim().toLowerCase();
    var list=$("list");list.innerHTML="";
    var rows=all.filter(function(r){
      if(!q)return true;
      return ((r.text||"")+" "+(r.user_label||"")+" "+(r.filename||"")+" "+(r.device_id||"")).toLowerCase().indexOf(q)>=0;
    });
    $("count").textContent=rows.length+" of "+all.length+" transcripts";
    renderUsage(rows);
    rows.forEach(function(r){
      var item=document.createElement("div");item.className="item";
      var meta=document.createElement("div");meta.className="meta";
      var left=document.createElement("span");
      var who=document.createElement("span");who.className="who";who.textContent=r.user_label||"—";
      left.appendChild(who);
      var fn=document.createElement("span");fn.className="muted";
      var dev=r.device_id?("  ·  #"+String(r.device_id).slice(0,8)):"";
      var dur=r.seconds?("  ·  "+Math.round(r.seconds)+"s"):"";
      fn.textContent="  ·  "+(r.filename||"")+"  ·  "+(r.lang||"")+"  ·  "+(r.chars||0)+" znakova"+dur+dev;
      left.appendChild(fn);
      var time=document.createElement("span");time.textContent=fmt(r.created_at);
      meta.appendChild(left);meta.appendChild(time);
      var txt=document.createElement("p");txt.className="txt";txt.textContent=r.text||"";
      item.appendChild(meta);item.appendChild(txt);
      list.appendChild(item);
    });
  }
  function load(){
    $("panelErr").classList.add("hidden");
    fetch("/api/admin/list",{headers:{"x-admin-password":pw()}}).then(function(res){
      return res.json().then(function(data){return {status:res.status,data:data}});
    }).then(function(r){
      if(r.status===401){setPw("");show(false);$("loginErr").textContent="Wrong password.";$("loginErr").classList.remove("hidden");return}
      if(r.status===503){show(true);$("panelErr").textContent=(r.data&&r.data.error)||"Admin not configured.";$("panelErr").classList.remove("hidden");all=[];render();return}
      if(!r.data||!r.data.transcripts){$("panelErr").textContent="Unexpected response.";$("panelErr").classList.remove("hidden");return}
      all=r.data.transcripts;show(true);render();
    }).catch(function(){$("panelErr").textContent="Network error.";$("panelErr").classList.remove("hidden")});
  }
  $("loginBtn").onclick=function(){var v=$("pw").value.trim();if(!v)return;setPw(v);$("loginErr").classList.add("hidden");load()};
  $("pw").addEventListener("keydown",function(e){if(e.key==="Enter")$("loginBtn").click()});
  $("refresh").onclick=load;
  $("filter").addEventListener("input",render);
  $("logout").onclick=function(){setPw("");all=[];show(false);$("pw").value=""};
  $("clear").onclick=function(){
    if(!confirm("Delete ALL logged transcripts? This cannot be undone."))return;
    fetch("/api/admin/clear",{method:"POST",headers:{"x-admin-password":pw()}}).then(function(res){
      if(res.ok){all=[];render()}else{alert("Could not clear.")}
    });
  };
  if(pw())load();else show(false);
</script>
</body>
</html>`;
