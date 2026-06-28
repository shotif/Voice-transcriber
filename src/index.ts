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
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/transcribe") {
      if (request.method === "POST") return handleTranscribe(request, env, ctx);
      if (request.method === "GET") return handleHealth(env);
      return json({ error: "Method not allowed." }, 405);
    }

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
    method: "POST multipart/form-data (field: file)",
    model_id: env.ELEVENLABS_MODEL_ID || DEFAULT_MODEL_ID,
    language_code: env.ELEVENLABS_LANGUAGE_CODE || DEFAULT_LANGUAGE_CODE,
    base_url: (env.ELEVENLABS_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, ""),
    key_configured: Boolean(env.ELEVENLABS_API_KEY),
    passcode_required: Boolean(env.APP_PASSCODE),
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
        { error: "Expected multipart/form-data with an audio 'file' field." },
        400,
      );
    }
    const f = inbound.get("file") ?? inbound.get("audio");
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
    ctx.waitUntil(logTranscript(env, { label, filename, lang, text }));
  }

  return json({
    text,
    language_code: lang,
    language_probability: result?.language_probability ?? null,
    model_id: modelId,
  });
}

// ---------- admin log (D1) ----------
const SCHEMA =
  "CREATE TABLE IF NOT EXISTS transcripts (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at INTEGER NOT NULL, user_label TEXT, filename TEXT, lang TEXT, chars INTEGER, text TEXT)";

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
  e: { label: string; filename: string; lang: string; text: string },
): Promise<void> {
  try {
    await env.DB!.prepare(SCHEMA).run();
    await env
      .DB!.prepare(
        "INSERT INTO transcripts (created_at, user_label, filename, lang, chars, text) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .bind(Date.now(), e.label, e.filename, e.lang, e.text.length, e.text)
      .run();
  } catch {
    /* logging must never break transcription */
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
    await env.DB!.prepare(SCHEMA).run();
    const { results } = await env
      .DB!.prepare(
        "SELECT id, created_at, user_label, filename, lang, chars, text FROM transcripts ORDER BY id DESC LIMIT 500",
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
  function render(){
    var q=$("filter").value.trim().toLowerCase();
    var list=$("list");list.innerHTML="";
    var rows=all.filter(function(r){
      if(!q)return true;
      return ((r.text||"")+" "+(r.user_label||"")+" "+(r.filename||"")).toLowerCase().indexOf(q)>=0;
    });
    $("count").textContent=rows.length+" of "+all.length+" transcripts";
    rows.forEach(function(r){
      var item=document.createElement("div");item.className="item";
      var meta=document.createElement("div");meta.className="meta";
      var left=document.createElement("span");
      var who=document.createElement("span");who.className="who";who.textContent=r.user_label||"—";
      left.appendChild(who);
      var fn=document.createElement("span");fn.className="muted";
      fn.textContent="  ·  "+(r.filename||"")+"  ·  "+(r.lang||"")+"  ·  "+(r.chars||0)+" chars";
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
