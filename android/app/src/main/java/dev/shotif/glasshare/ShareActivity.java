package dev.shotif.glasshare;

import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.media.MediaMetadataRetriever;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.OpenableColumns;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.UUID;

/**
 * Receives a shared voice note, transcribes it through the Glas Worker, and
 * hands the transcript on to the installed Glas app.
 *
 * <p>This exists because Chrome's Web Share Target never delivered the file:
 * the PWA's service worker kept receiving an empty multipart body while the
 * same voice note attached fine in other apps. An ACTION_SEND intent handled
 * here arrives with its read grant intact, because there is no second hop for
 * the grant to be lost on.
 */
public class ShareActivity extends Activity {

  private static final String PREFS = "glas";
  private static final String KEY_BASE = "base_url";
  private static final String KEY_PASS = "passcode";
  private static final String KEY_NAME = "name";
  private static final String KEY_DEVICE = "device_id";

  private static final String DEFAULT_BASE = "https://glas.shotif.workers.dev";
  private static final int MAX_BYTES = 25 * 1024 * 1024;

  private final Handler ui = new Handler(Looper.getMainLooper());
  private SharedPreferences prefs;

  private TextView status;
  private TextView transcript;
  private View settings;
  private View transcriptScroll;
  private View actions;
  private EditText passInput;
  private EditText nameInput;
  private EditText baseInput;

  private Uri pendingUri; // held while the user fills in the access code
  private String lastText = "";
  private String lastHandoff;

  @Override
  protected void onCreate(Bundle state) {
    super.onCreate(state);
    setContentView(R.layout.activity_share);
    setTitle(R.string.app_name);

    status = findViewById(R.id.status);
    transcript = findViewById(R.id.transcript);
    settings = findViewById(R.id.settings);
    transcriptScroll = findViewById(R.id.transcriptScroll);
    actions = findViewById(R.id.actions);
    passInput = findViewById(R.id.passInput);
    nameInput = findViewById(R.id.nameInput);
    baseInput = findViewById(R.id.baseInput);

    prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
    if (prefs.getString(KEY_DEVICE, null) == null) {
      prefs.edit().putString(KEY_DEVICE, "android-" + UUID.randomUUID()).apply();
    }

    ((Button) findViewById(R.id.saveBtn)).setOnClickListener(v -> saveSettings());
    ((Button) findViewById(R.id.copyBtn)).setOnClickListener(v -> copyTranscript());
    ((Button) findViewById(R.id.shareBtn)).setOnClickListener(v -> shareTranscript());
    ((Button) findViewById(R.id.openBtn)).setOnClickListener(v -> openInGlas());

    Uri shared = extractUri(getIntent());
    if (shared == null) {
      showSettings("Postavke. Pristupni kôd je isti onaj koji koristiš u Glasu.");
      return;
    }
    if (pass().isEmpty()) {
      pendingUri = shared;
      showSettings("Unesi pristupni kôd, pa nastavljam s prijepisom.");
      return;
    }
    start(shared);
  }

  // ---------- settings ----------

  private void showSettings(String message) {
    status.setText(message);
    passInput.setText(pass());
    nameInput.setText(prefs.getString(KEY_NAME, ""));
    baseInput.setText(base());
    settings.setVisibility(View.VISIBLE);
  }

  private void saveSettings() {
    String code = passInput.getText().toString().trim();
    String name = nameInput.getText().toString().trim();
    String url = baseInput.getText().toString().trim().replaceAll("/+$", "");
    prefs
        .edit()
        .putString(KEY_PASS, code)
        .putString(KEY_NAME, name)
        .putString(KEY_BASE, url.isEmpty() ? DEFAULT_BASE : url)
        .apply();
    settings.setVisibility(View.GONE);

    if (pendingUri != null) {
      Uri u = pendingUri;
      pendingUri = null;
      start(u);
    } else {
      status.setText("Spremljeno. Sad podijeli glasovnu poruku iz WhatsAppa u ovu aplikaciju.");
    }
  }

  private String base() {
    return prefs.getString(KEY_BASE, DEFAULT_BASE);
  }

  private String pass() {
    return prefs.getString(KEY_PASS, "");
  }

  // ---------- share intake ----------

  private Uri extractUri(Intent intent) {
    if (intent == null) return null;
    String action = intent.getAction();
    if (Intent.ACTION_SEND.equals(action)) {
      Uri u = intent.getParcelableExtra(Intent.EXTRA_STREAM);
      if (u != null) return u;
    } else if (Intent.ACTION_SEND_MULTIPLE.equals(action)) {
      ArrayList<Uri> list = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
      if (list != null && !list.isEmpty()) return list.get(0);
    }
    // Some senders only populate ClipData.
    ClipData clip = intent.getClipData();
    if (clip != null && clip.getItemCount() > 0) return clip.getItemAt(0).getUri();
    return null;
  }

  private void start(Uri uri) {
    status.setText("Prepisujem… ovo može potrajati nekoliko sekundi.");
    new Thread(
            () -> {
              try {
                String name = displayName(uri);
                String type = getContentResolver().getType(uri);
                if (type == null || type.isEmpty()) type = "audio/ogg";
                long seconds = durationSeconds(uri);
                byte[] audio = readAll(uri);
                if (audio.length == 0) {
                  ui.post(() -> fail("Podijeljena datoteka je prazna."));
                  return;
                }
                transcribe(audio, name, type, seconds);
              } catch (SecurityException e) {
                ui.post(
                    () ->
                        fail(
                            "Nemam dopuštenje za čitanje te datoteke. Podijeli ju ponovno iz WhatsAppa."));
              } catch (Exception e) {
                ui.post(() -> fail("Ne mogu pročitati datoteku: " + e.getMessage()));
              }
            })
        .start();
  }

  private String displayName(Uri uri) {
    try (Cursor c =
        getContentResolver().query(uri, new String[] {OpenableColumns.DISPLAY_NAME}, null, null, null)) {
      if (c != null && c.moveToFirst()) {
        String n = c.getString(0);
        if (n != null && !n.trim().isEmpty()) return n.trim();
      }
    } catch (Exception ignored) {
      // fall through to the default below
    }
    return "voice-note.ogg";
  }

  private long durationSeconds(Uri uri) {
    MediaMetadataRetriever r = new MediaMetadataRetriever();
    try {
      r.setDataSource(this, uri);
      String ms = r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION);
      if (ms != null) return Math.round(Long.parseLong(ms) / 1000.0);
    } catch (Exception ignored) {
      // duration is only used for the usage log
    } finally {
      try {
        r.release();
      } catch (Exception ignored) {
        // nothing to do
      }
    }
    return 0;
  }

  private byte[] readAll(Uri uri) throws IOException {
    try (InputStream in = getContentResolver().openInputStream(uri)) {
      if (in == null) throw new IOException("stream nije dostupan");
      ByteArrayOutputStream out = new ByteArrayOutputStream();
      byte[] buf = new byte[16 * 1024];
      int n;
      while ((n = in.read(buf)) > 0) {
        out.write(buf, 0, n);
        if (out.size() > MAX_BYTES) throw new IOException("datoteka je prevelika");
      }
      return out.toByteArray();
    }
  }

  // ---------- Worker call ----------

  private void transcribe(byte[] audio, String name, String type, long seconds) {
    String boundary = "glas" + System.currentTimeMillis();
    HttpURLConnection c = null;
    try {
      c = (HttpURLConnection) new URL(base() + "/api/transcribe?handoff=1").openConnection();
      c.setRequestMethod("POST");
      c.setDoOutput(true);
      c.setConnectTimeout(20000);
      c.setReadTimeout(180000);
      c.setRequestProperty("Content-Type", "multipart/form-data; boundary=" + boundary);
      c.setRequestProperty("x-app-passcode", pass());
      c.setRequestProperty("x-device-id", prefs.getString(KEY_DEVICE, ""));
      String label = prefs.getString(KEY_NAME, "");
      if (!label.isEmpty()) c.setRequestProperty("x-user-label", Uri.encode(label));
      if (seconds > 0) c.setRequestProperty("x-audio-seconds", String.valueOf(seconds));
      c.setFixedLengthStreamingMode(
          multipartLength(boundary, name, type, audio.length));

      try (OutputStream out = c.getOutputStream()) {
        out.write(partHeader(boundary, name, type).getBytes(StandardCharsets.UTF_8));
        out.write(audio);
        out.write(("\r\n--" + boundary + "--\r\n").getBytes(StandardCharsets.UTF_8));
      }

      int code = c.getResponseCode();
      String body = readString(code < 400 ? c.getInputStream() : c.getErrorStream());
      handleResponse(code, body);
    } catch (Exception e) {
      String msg = e.getMessage();
      ui.post(() -> fail("Ne mogu doći do Glasa: " + msg));
    } finally {
      if (c != null) c.disconnect();
    }
  }

  private String partHeader(String boundary, String name, String type) {
    return "--"
        + boundary
        + "\r\nContent-Disposition: form-data; name=\"file\"; filename=\""
        + name.replace("\"", "")
        + "\"\r\nContent-Type: "
        + type
        + "\r\n\r\n";
  }

  private long multipartLength(String boundary, String name, String type, int audioLength) {
    return partHeader(boundary, name, type).getBytes(StandardCharsets.UTF_8).length
        + audioLength
        + ("\r\n--" + boundary + "--\r\n").getBytes(StandardCharsets.UTF_8).length;
  }

  private String readString(InputStream in) throws IOException {
    if (in == null) return "";
    try (InputStream s = in) {
      ByteArrayOutputStream out = new ByteArrayOutputStream();
      byte[] buf = new byte[8 * 1024];
      int n;
      while ((n = s.read(buf)) > 0) out.write(buf, 0, n);
      return new String(out.toByteArray(), StandardCharsets.UTF_8);
    }
  }

  private void handleResponse(int code, String body) {
    String text = "";
    String error = "";
    String handoff = null;
    try {
      JSONObject o = new JSONObject(body);
      text = o.optString("text", "").trim();
      error = o.optString("error", "");
      if (!o.isNull("handoff_id")) handoff = o.optString("handoff_id", null);
    } catch (Exception ignored) {
      // a non-JSON body is reported verbatim below
    }

    if (code == 401) {
      ui.post(
          () -> {
            prefs.edit().remove(KEY_PASS).apply();
            showSettings("Pogrešan pristupni kôd. Unesi ga ponovno.");
          });
      return;
    }
    if (code >= 400 || text.isEmpty()) {
      String msg =
          !error.isEmpty()
              ? error
              : text.isEmpty() && code < 400
                  ? "U toj snimci nema prepoznatljivog govora."
                  : "Prijepis nije uspio (HTTP " + code + ").";
      ui.post(() -> fail(msg));
      return;
    }

    final String finalText = text;
    final String finalHandoff = handoff;
    ui.post(() -> succeed(finalText, finalHandoff));
  }

  // ---------- result ----------

  private void succeed(String text, String handoff) {
    lastText = text;
    lastHandoff = handoff;
    status.setText("Gotovo — prijepis je kopiran.");
    transcript.setText(text);
    transcriptScroll.setVisibility(View.VISIBLE);
    actions.setVisibility(View.VISIBLE);
    setClipboard(text);
  }

  private void fail(String message) {
    status.setText(message == null ? "Nešto je pošlo po zlu." : message);
  }

  private void setClipboard(String text) {
    ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
    if (cm != null) cm.setPrimaryClip(ClipData.newPlainText("Glas", text));
  }

  private void copyTranscript() {
    if (lastText.isEmpty()) return;
    setClipboard(lastText);
    Toast.makeText(this, "Kopirano", Toast.LENGTH_SHORT).show();
  }

  private void shareTranscript() {
    if (lastText.isEmpty()) return;
    Intent i = new Intent(Intent.ACTION_SEND);
    i.setType("text/plain");
    i.putExtra(Intent.EXTRA_TEXT, lastText);
    startActivity(Intent.createChooser(i, "Podijeli prijepis"));
  }

  /** Opens Glas, which collects the transcript and stores it in its history. */
  private void openInGlas() {
    String url =
        lastHandoff == null ? base() + "/" : base() + "/?pickup=" + Uri.encode(lastHandoff);
    try {
      startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
      finish();
    } catch (Exception e) {
      Toast.makeText(this, "Ne mogu otvoriti Glas.", Toast.LENGTH_SHORT).show();
    }
  }
}
