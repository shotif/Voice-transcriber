/**
 * POST /api/transcribe
 *
 * Same-origin proxy to the ElevenLabs Speech-to-Text ("Scribe") API.
 * The browser uploads an audio file as multipart/form-data; this function
 * forwards it to ElevenLabs with the secret API key (which lives ONLY in the
 * Cloudflare Pages environment, never in the client bundle) and returns the
 * Croatian transcript.
 *
 * ElevenLabs request shape (verified against the current docs, June 2026):
 *   POST https://api.elevenlabs.io/v1/speech-to-text
 *   Header: xi-api-key: <ELEVENLABS_API_KEY>
 *   multipart/form-data fields:
 *     file          -> the audio (required)
 *     model_id      -> required. scribe_v1 is deprecated (removed 2026-07-09),
 *                      so we default to scribe_v2.
 *     language_code -> ISO-639-1/3 code. Croatian = "hr". Forces the language.
 */

interface Env {
  ELEVENLABS_API_KEY: string;
  // Optional overrides (set in the Pages dashboard if you ever need them):
  ELEVENLABS_MODEL_ID?: string;
  ELEVENLABS_LANGUAGE_CODE?: string;
}

const ELEVENLABS_URL = "https://api.elevenlabs.io/v1/speech-to-text";
const DEFAULT_MODEL_ID = "scribe_v2";
const DEFAULT_LANGUAGE_CODE = "hr"; // Croatian
const MAX_BYTES = 100 * 1024 * 1024; // 100 MB guardrail; voice notes are tiny

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { request, env } = context;

  if (!env.ELEVENLABS_API_KEY) {
    return json(
      {
        error:
          "Server is missing ELEVENLABS_API_KEY. Add it as an encrypted environment variable in the Cloudflare Pages project settings.",
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

  const outbound = new FormData();
  // WhatsApp .opus blobs sometimes arrive with a generic type; give ElevenLabs
  // a filename so it can sniff the container.
  const filename = file.name || "voice-note.ogg";
  outbound.set("file", file, filename);
  outbound.set("model_id", modelId);
  outbound.set("language_code", languageCode);

  let elevenRes: Response;
  try {
    elevenRes = await fetch(ELEVENLABS_URL, {
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
};

// Friendly response for accidental GETs / health checks.
export const onRequestGet: PagesFunction<Env> = async ({ env }) =>
  json({
    ok: true,
    route: "/api/transcribe",
    method: "POST multipart/form-data (field: file)",
    model_id: env.ELEVENLABS_MODEL_ID || DEFAULT_MODEL_ID,
    language_code: env.ELEVENLABS_LANGUAGE_CODE || DEFAULT_LANGUAGE_CODE,
    key_configured: Boolean(env.ELEVENLABS_API_KEY),
  });
