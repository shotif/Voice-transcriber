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
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/transcribe") {
      if (request.method === "POST") return handleTranscribe(request, env);
      if (request.method === "GET") return handleHealth(env);
      return json({ error: "Method not allowed." }, 405);
    }

    // Everything else is a static asset (index.html, app.js, sw.js, icons, …).
    return env.ASSETS.fetch(request);
  },
};

function handleHealth(env: Env): Response {
  return json({
    ok: true,
    route: "/api/transcribe",
    method: "POST multipart/form-data (field: file)",
    model_id: env.ELEVENLABS_MODEL_ID || DEFAULT_MODEL_ID,
    language_code: env.ELEVENLABS_LANGUAGE_CODE || DEFAULT_LANGUAGE_CODE,
    base_url: (env.ELEVENLABS_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, ""),
    key_configured: Boolean(env.ELEVENLABS_API_KEY),
    passcode_required: Boolean(env.APP_PASSCODE),
  });
}

async function handleTranscribe(request: Request, env: Env): Promise<Response> {
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

  let inbound: FormData;
  try {
    inbound = await request.formData();
  } catch {
    return json(
      { error: "Expected multipart/form-data with an audio 'file' field." },
      400,
    );
  }

  const file = inbound.get("file") ?? inbound.get("audio");
  if (!(file instanceof File)) {
    return json({ error: "No audio file found in the request." }, 400);
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
  return json({
    text,
    language_code: result?.language_code ?? languageCode,
    language_probability: result?.language_probability ?? null,
    model_id: modelId,
  });
}
