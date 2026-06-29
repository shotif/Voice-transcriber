/* Glas — frontend logic (vanilla JS, no build step).
 * Handles file selection, share-target intake, the /api/transcribe call,
 * copy-to-clipboard, and a localStorage history of the last ~10 transcripts.
 */
(() => {
  "use strict";

  const MAX_HISTORY = 10;
  const HISTORY_KEY = "glas:history:v1";
  const PASS_KEY = "glas:passcode:v1";
  const NAME_KEY = "glas:username:v1";
  const ACCEPTED = /\.(opus|ogg|oga|m4a|mp3|wav|mp4|webm|aac|flac)$/i;

  const $ = (id) => document.getElementById(id);
  const el = {
    dropzone: $("dropzone"),
    fileInput: $("fileInput"),
    filePreview: $("filePreview"),
    fileName: $("fileName"),
    audioPlayer: $("audioPlayer"),
    transcribeBtn: $("transcribeBtn"),
    clearFile: $("clearFile"),
    loading: $("loading"),
    error: $("error"),
    result: $("result"),
    transcript: $("transcript"),
    langBadge: $("langBadge"),
    copyBtn: $("copyBtn"),
    summarizeBtn: $("summarizeBtn"),
    summaryWrap: $("summaryWrap"),
    summary: $("summary"),
    copySummaryBtn: $("copySummaryBtn"),
    summaryLoading: $("summaryLoading"),
    historySection: $("historySection"),
    historyList: $("historyList"),
    clearHistory: $("clearHistory"),
    toast: $("toast"),
    installHint: $("installHint"),
    unlock: $("unlock"),
    unlockForm: $("unlockForm"),
    unlockMsg: $("unlockMsg"),
    passcodeInput: $("passcodeInput"),
    nameInput: $("nameInput"),
    changeCode: $("changeCode"),
  };

  let currentFile = null;
  let currentObjectUrl = null;
  let summarizeEnabled = false; // learned from the health route
  let currentTranscript = ""; // text backing the visible result card

  // ---------- helpers ----------
  const show = (node) => node.classList.remove("hidden");
  const hide = (node) => node.classList.add("hidden");

  let toastTimer;
  function toast(msg) {
    el.toast.textContent = msg;
    show(el.toast);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => hide(el.toast), 2200);
  }

  function humanSize(bytes) {
    if (!bytes) return "";
    const units = ["B", "KB", "MB"];
    let i = 0,
      n = bytes;
    while (n >= 1024 && i < units.length - 1) {
      n /= 1024;
      i++;
    }
    return ` · ${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
  }

  function showError(msg) {
    el.error.textContent = msg;
    show(el.error);
    hide(el.loading);
  }

  // ---------- file selection ----------
  function looksLikeAudio(file) {
    if (!file) return false;
    if (file.type && file.type.startsWith("audio/")) return true;
    if (file.type === "video/mp4" || file.type === "application/ogg") return true; // m4a/ogg quirks
    return ACCEPTED.test(file.name || "");
  }

  function setFile(file, displayName) {
    if (!file) return;
    if (!looksLikeAudio(file)) {
      showError(
        "That doesn't look like an audio file. Supported: .opus, .ogg, .m4a, .mp3, .wav.",
      );
      return;
    }
    currentFile = file;
    if (currentObjectUrl) URL.revokeObjectURL(currentObjectUrl);
    currentObjectUrl = URL.createObjectURL(file);

    const name = displayName || file.name || "voice-note";
    el.fileName.textContent = name + humanSize(file.size);
    el.audioPlayer.src = currentObjectUrl;

    hide(el.error);
    hide(el.result);
    show(el.filePreview);
    el.filePreview.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  function clearFile() {
    currentFile = null;
    if (currentObjectUrl) {
      URL.revokeObjectURL(currentObjectUrl);
      currentObjectUrl = null;
    }
    el.fileInput.value = "";
    el.audioPlayer.removeAttribute("src");
    el.audioPlayer.load();
    hide(el.filePreview);
    hide(el.result);
    hide(el.error);
  }

  // ---------- transcription ----------
  async function transcribe() {
    if (!currentFile) return;
    hide(el.error);
    hide(el.result);
    show(el.loading);
    el.transcribeBtn.disabled = true;

    try {
      const form = new FormData();
      form.append("file", currentFile, currentFile.name || "voice-note.ogg");

      const headers = {};
      const pass = getPass();
      if (pass) headers["x-app-passcode"] = pass;
      const name = getName();
      if (name) headers["x-user-label"] = encodeURIComponent(name);

      const res = await fetch("/api/transcribe", { method: "POST", body: form, headers });
      let data;
      try {
        data = await res.json();
      } catch {
        throw new Error(`Server returned an unreadable response (HTTP ${res.status}).`);
      }
      // Wrong/missing access code → reopen the unlock gate instead of erroring.
      if (res.status === 401 && data?.code === "passcode") {
        hide(el.loading);
        setPass("");
        showUnlock("Pogrešan pristupni kôd. Pokušaj ponovno.");
        return;
      }
      if (!res.ok) throw new Error(data?.error || `Transcription failed (HTTP ${res.status}).`);

      const text = (data.text || "").trim();
      hide(el.loading);
      if (!text) {
        showError("No speech was detected in that audio. Try a different recording.");
        return;
      }
      renderResult(text, data.language_code || "hr");
      saveToHistory({
        text,
        name: currentFile.name || "voice-note",
        lang: data.language_code || "hr",
        at: Date.now(),
      });
    } catch (err) {
      const offline = !navigator.onLine;
      showError(
        offline
          ? "You appear to be offline. Reconnect and try again."
          : err.message || "Something went wrong. Please try again.",
      );
    } finally {
      el.transcribeBtn.disabled = false;
    }
  }

  function renderResult(text, lang, summary) {
    currentTranscript = text;
    el.transcript.textContent = text;
    el.langBadge.textContent = lang === "hr" ? "hrvatski" : lang;
    el.copyBtn.classList.remove("copied");
    el.copyBtn.textContent = "Copy";
    // Reset summary UI for this result.
    hide(el.summaryLoading);
    if (summary) {
      el.summary.textContent = summary;
      show(el.summaryWrap);
      hide(el.summarizeBtn);
    } else {
      hide(el.summaryWrap);
      el.summary.textContent = "";
      if (summarizeEnabled) {
        el.summarizeBtn.classList.remove("hidden");
        el.summarizeBtn.disabled = false;
        el.summarizeBtn.textContent = "Sažmi";
      }
    }
    show(el.result);
    el.result.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  async function summarizeCurrent() {
    const text = currentTranscript.trim();
    if (!text) return;
    hide(el.summaryWrap);
    show(el.summaryLoading);
    el.summarizeBtn.disabled = true;
    try {
      const headers = { "content-type": "application/json" };
      const pass = getPass();
      if (pass) headers["x-app-passcode"] = pass;
      const res = await fetch("/api/summarize", {
        method: "POST",
        headers,
        body: JSON.stringify({ text }),
      });
      let data;
      try {
        data = await res.json();
      } catch {
        throw new Error(`Server returned an unreadable response (HTTP ${res.status}).`);
      }
      if (res.status === 401) {
        setPass("");
        showUnlock("Pogrešan pristupni kôd. Pokušaj ponovno.");
        return;
      }
      if (!res.ok) throw new Error(data?.error || `Sažimanje nije uspjelo (HTTP ${res.status}).`);
      const summary = (data.summary || "").trim();
      if (!summary) throw new Error("Sažetak je stigao prazan.");
      el.summary.textContent = summary;
      show(el.summaryWrap);
      hide(el.summarizeBtn);
      updateHistorySummary(text, summary);
    } catch (err) {
      el.summarizeBtn.disabled = false;
      toast(err.message || "Sažimanje nije uspjelo.");
    } finally {
      hide(el.summaryLoading);
    }
  }

  async function copyText(text, btn) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      if (btn) {
        btn.classList.add("copied");
        btn.textContent = "Copied ✓";
        setTimeout(() => {
          btn.classList.remove("copied");
          btn.textContent = "Copy";
        }, 1800);
      }
      toast("Copied to clipboard");
    } catch {
      toast("Couldn't copy — long-press to select.");
    }
  }

  // ---------- history (localStorage) ----------
  function readHistory() {
    try {
      const raw = localStorage.getItem(HISTORY_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  }
  function writeHistory(arr) {
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(arr.slice(0, MAX_HISTORY)));
    } catch {
      /* storage full / disabled — non-fatal */
    }
  }
  function saveToHistory(entry) {
    const arr = readHistory();
    arr.unshift(entry);
    writeHistory(arr);
    renderHistory();
  }
  // Attach a generated summary to the most recent matching history entry.
  function updateHistorySummary(text, summary) {
    const arr = readHistory();
    const item = arr.find((e) => e.text === text);
    if (item) {
      item.summary = summary;
      writeHistory(arr);
      renderHistory();
    }
  }
  function relativeTime(ts) {
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60) return "just now";
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.floor(h / 24);
    return d === 1 ? "yesterday" : `${d}d ago`;
  }
  function renderHistory() {
    const arr = readHistory();
    if (!arr.length) {
      hide(el.historySection);
      el.historyList.innerHTML = "";
      return;
    }
    show(el.historySection);
    el.historyList.innerHTML = "";
    arr.forEach((item) => {
      const li = document.createElement("li");
      li.className = "history-item";

      const top = document.createElement("div");
      top.className = "hi-top";
      const name = document.createElement("span");
      name.className = "hi-name";
      name.textContent = item.name || "voice-note";
      const time = document.createElement("span");
      time.className = "hi-time";
      time.textContent = relativeTime(item.at);
      top.append(name, time);

      const p = document.createElement("p");
      p.className = "hi-text";
      p.textContent = item.text;

      li.append(top, p);
      li.addEventListener("click", () => {
        renderResult(item.text, item.lang || "hr", item.summary);
        copyText(item.text, el.copyBtn);
      });
      el.historyList.appendChild(li);
    });
  }

  // ---------- access code (shared passcode) ----------
  function getPass() {
    try {
      return localStorage.getItem(PASS_KEY) || "";
    } catch {
      return "";
    }
  }
  function setPass(v) {
    try {
      if (v) localStorage.setItem(PASS_KEY, v);
      else localStorage.removeItem(PASS_KEY);
    } catch {
      /* storage disabled — non-fatal */
    }
  }
  function getName() {
    try {
      return localStorage.getItem(NAME_KEY) || "";
    } catch {
      return "";
    }
  }
  function setName(v) {
    try {
      if (v) localStorage.setItem(NAME_KEY, v);
      else localStorage.removeItem(NAME_KEY);
    } catch {
      /* non-fatal */
    }
  }
  function showUnlock(msg) {
    if (msg) el.unlockMsg.textContent = msg;
    show(el.unlock);
    el.passcodeInput.value = getPass();
    el.nameInput.value = getName();
    el.passcodeInput.focus();
  }
  async function initPasscodeGate() {
    let required = false;
    try {
      const res = await fetch("/api/transcribe", { method: "GET" });
      const data = await res.json();
      required = Boolean(data?.passcode_required);
      summarizeEnabled = Boolean(data?.summarize_enabled);
    } catch {
      required = false; // offline or health failed — let transcribe handle 401
    }
    if (required) {
      show(el.changeCode);
      if (!getPass()) showUnlock("Unesi pristupni kôd da koristiš transkripciju.");
    }
    // If a result is already on screen (e.g. from history), reveal the button now.
    if (summarizeEnabled && !el.result.classList.contains("hidden") && el.summaryWrap.classList.contains("hidden")) {
      el.summarizeBtn.classList.remove("hidden");
    }
  }

  // ---------- share target intake ----------
  async function loadSharedAudio() {
    const params = new URLSearchParams(location.search);
    if (!params.has("shared")) return;
    // Clean the URL so a refresh doesn't re-trigger.
    history.replaceState({}, "", location.pathname);

    if (!navigator.serviceWorker?.controller) {
      // Give the SW a brief moment to take control after first install.
      await new Promise((r) => setTimeout(r, 400));
    }
    const ctrl = navigator.serviceWorker?.controller;
    if (!ctrl) {
      showError("Shared audio couldn't be read. Try uploading the file manually.");
      return;
    }

    const file = await new Promise((resolve) => {
      const timeout = setTimeout(() => resolve(null), 4000);
      const onMsg = (event) => {
        if (event.data?.type === "shared-audio") {
          clearTimeout(timeout);
          navigator.serviceWorker.removeEventListener("message", onMsg);
          resolve(event.data);
        }
      };
      navigator.serviceWorker.addEventListener("message", onMsg);
      ctrl.postMessage("get-shared-audio");
    });

    if (file?.file) {
      const name = file.filename || "shared-voice-note.ogg";
      const blob = file.file instanceof Blob ? file.file : new Blob([file.file]);
      const f = new File([blob], name, { type: blob.type || "audio/ogg" });
      setFile(f, name);
      toast("Voice note received — tap Transcribe");
    }
  }

  // ---------- events ----------
  el.dropzone.addEventListener("click", () => el.fileInput.click());
  el.dropzone.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      el.fileInput.click();
    }
  });
  el.fileInput.addEventListener("change", (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) setFile(f);
  });

  ["dragenter", "dragover"].forEach((ev) =>
    el.dropzone.addEventListener(ev, (e) => {
      e.preventDefault();
      el.dropzone.classList.add("dragover");
    }),
  );
  ["dragleave", "dragend", "drop"].forEach((ev) =>
    el.dropzone.addEventListener(ev, (e) => {
      e.preventDefault();
      el.dropzone.classList.remove("dragover");
    }),
  );
  el.dropzone.addEventListener("drop", (e) => {
    const f = e.dataTransfer?.files && e.dataTransfer.files[0];
    if (f) setFile(f);
  });

  el.clearFile.addEventListener("click", clearFile);
  el.transcribeBtn.addEventListener("click", transcribe);
  el.copyBtn.addEventListener("click", () => copyText(el.transcript.textContent, el.copyBtn));
  el.summarizeBtn.addEventListener("click", summarizeCurrent);
  el.copySummaryBtn.addEventListener("click", () => copyText(el.summary.textContent, el.copySummaryBtn));
  el.unlockForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const code = el.passcodeInput.value.trim();
    if (!code) return;
    setPass(code);
    setName(el.nameInput.value.trim());
    hide(el.unlock);
    toast("Pristupni kôd spremljen");
  });
  el.changeCode.addEventListener("click", () =>
    showUnlock("Unesi novi pristupni kôd."),
  );

  el.clearHistory.addEventListener("click", () => {
    if (confirm("Clear all saved transcripts?")) {
      writeHistory([]);
      renderHistory();
      toast("History cleared");
    }
  });

  // ---------- init ----------
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    });
  }
  if (!window.matchMedia("(display-mode: standalone)").matches && el.installHint) {
    show(el.installHint);
  }

  renderHistory();
  initPasscodeGate();
  loadSharedAudio();
})();
