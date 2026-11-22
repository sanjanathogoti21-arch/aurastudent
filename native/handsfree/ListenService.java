package app.aurastudent.planner;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import org.json.JSONObject;
import org.vosk.Model;
import org.vosk.Recognizer;
import org.vosk.android.RecognitionListener;
import org.vosk.android.SpeechService;
import org.vosk.android.StorageService;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Foreground service (type: microphone) that listens on this phone for "Hey Aura".
 * Speech is recognised on the phone by Vosk. Anything that does not start with the wake phrase is thrown away.
 * It can only be started while the AuraStudent screen is open (Android rule) and shows a notification with a Stop button the whole time.
 */
public class ListenService extends Service implements RecognitionListener, TextToSpeech.OnInitListener {

    public static final String ACTION_STOP = "app.aurastudent.planner.STOP";
    static final String CH = "listening";
    static final int NID = 11;
    public static volatile boolean running = false;
    public static volatile String status = "Hands-free is off.";
    public static volatile Runnable onStatus;

    static void setStatus(String s) {
        status = s;
        new Handler(Looper.getMainLooper()).post(new Runnable() {
            public void run() { Runnable r = onStatus; if (r != null) r.run(); }
        });
    }

    private final Handler main = new Handler(Looper.getMainLooper());
    private Model model;
    private SpeechService speech;
    private TextToSpeech tts;
    private boolean ttsReady = false;
    private PowerManager.WakeLock wake;

    private boolean busy = false;
    private long commandUntil = 0;
    private JSONObject prior = null;
    private long priorUntil = 0;
    private int asks = 0;

    private static final Pattern WAKE = Pattern.compile(
        "^(?:hey|hi|okay|ok|hay|a)\\s+(?:aura|aurora|ora|laura|ara|ira|arora|or a)\\b[\\s,.]*(.*)$");

    @Override public IBinder onBind(Intent i) { return null; }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            if (running) stopListening("Hands-free is off.");
            else { stopForeground(true); stopSelf(); }
            return START_NOT_STICKY;
        }
        if (running) return START_NOT_STICKY;
        if (!startInForeground("Starting. Loading the speech model...")) {
            running = false;
            setStatus("Android did not allow listening to start. Open AuraStudent and try again.");
            stopSelf();
            return START_NOT_STICKY;
        }
        running = true;
        setStatus("Loading the speech model (first start takes a little while)...");
        tts = new TextToSpeech(this, this);
        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        wake = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "AuraStudent:listen");
        wake.acquire();
        StorageService.unpack(this, "model", "model",
            new StorageService.Callback<Model>() { public void onComplete(Model m) { model = m; startRecognizer(); } },
            new StorageService.Callback<java.io.IOException>() { public void onComplete(java.io.IOException e) { fail("The speech model could not be loaded: " + e.getMessage()); } });
        return START_NOT_STICKY;
    }

    private boolean startInForeground(String text) {
        try {
            NotificationManager nm = getSystemService(NotificationManager.class);
            if (nm.getNotificationChannel(CH) == null)
                nm.createNotificationChannel(new NotificationChannel(CH, "Hands-free listening", NotificationManager.IMPORTANCE_LOW));
            Notification n = notification(text);
            if (Build.VERSION.SDK_INT >= 29) startForeground(NID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE);
            else startForeground(NID, n);
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    private Notification notification(String text) {
        PendingIntent open = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class), PendingIntent.FLAG_IMMUTABLE);
        PendingIntent stop = PendingIntent.getService(this, 1, new Intent(this, ListenService.class).setAction(ACTION_STOP), PendingIntent.FLAG_IMMUTABLE);
        return new Notification.Builder(this, CH)
            .setSmallIcon(R.drawable.ic_stat)
            .setContentTitle("AuraStudent is listening for \"Hey Aura\"")
            .setContentText(text)
            .setOngoing(true)
            .setContentIntent(open)
            .addAction(new Notification.Action.Builder(null, "Stop listening", stop).build())
            .build();
    }

    private void updateNote(String text) {
        try { getSystemService(NotificationManager.class).notify(NID, notification(text)); } catch (Exception ignore) { }
    }

    private void startRecognizer() {
        try {
            Recognizer rec = new Recognizer(model, 16000.0f);
            speech = new SpeechService(rec, 16000.0f);
            speech.startListening(this);
            setStatus("Listening for \"Hey Aura\". Microphone is on.");
            updateNote("Say: Hey Aura, add task ... tomorrow at 4 pm");
        } catch (Exception e) {
            fail("I could not start the microphone: " + e.getMessage());
        }
    }

    private void fail(String msg) {
        speakOnce("Hands-free listening stopped. " + msg);
        stopListening("Stopped: " + msg);
    }

    private void stopListening(String msg) {
        running = false;
        try { if (speech != null) { speech.stop(); speech.shutdown(); } } catch (Exception ignore) { }
        speech = null;
        try { if (model != null) model.close(); } catch (Exception ignore) { }
        model = null;
        try { if (wake != null && wake.isHeld()) wake.release(); } catch (Exception ignore) { }
        final TextToSpeech t = tts;
        main.postDelayed(new Runnable() { public void run() { try { if (t != null) t.shutdown(); } catch (Exception ignore) { } } }, 3000);
        tts = null;
        setStatus(msg);
        stopForeground(true);
        stopSelf();
    }

    @Override
    public void onDestroy() {
        running = false;
        try { if (speech != null) speech.shutdown(); } catch (Exception ignore) { }
        try { if (wake != null && wake.isHeld()) wake.release(); } catch (Exception ignore) { }
        if (!status.startsWith("Stopped")) status = "Hands-free is off.";
        setStatus(status);
        super.onDestroy();
    }

    // ---------- speech out ----------
    @Override
    public void onInit(int code) {
        if (code == TextToSpeech.SUCCESS && tts != null) {
            int r = tts.setLanguage(new Locale("en", "IN"));
            if (r == TextToSpeech.LANG_MISSING_DATA || r == TextToSpeech.LANG_NOT_SUPPORTED) tts.setLanguage(Locale.US);
            ttsReady = true;
            tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                @Override public void onStart(String id) { }
                @Override public void onDone(String id) { main.post(new Runnable() { public void run() { resume(); } }); }
                @Override public void onError(String id) { main.post(new Runnable() { public void run() { resume(); } }); }
            });
        }
    }

    private void speakOnce(String text) {
        if (ttsReady && tts != null) tts.speak(text, TextToSpeech.QUEUE_FLUSH, null, "u" + System.nanoTime());
    }

    /** Speak, keeping the microphone paused meanwhile so Aura does not hear herself. */
    private void say(String text) {
        updateNote(text);
        if (!ttsReady || tts == null) { resume(); return; }
        if (speech != null) speech.setPause(true);
        tts.speak(text, TextToSpeech.QUEUE_FLUSH, null, "u" + System.nanoTime());
        main.postDelayed(new Runnable() { public void run() { resume(); } }, 12000); // never stay deaf
    }

    private void resume() {
        busy = false;
        if (running) {
            if (speech != null) speech.setPause(false);
            setStatus("Listening for \"Hey Aura\". Microphone is on.");
        }
    }

    // ---------- recognition ----------
    @Override public void onPartialResult(String h) { }
    @Override public void onFinalResult(String h) { }
    @Override public void onTimeout() { }
    @Override public void onError(Exception e) { fail("The microphone stopped (" + (e == null ? "unknown" : e.getMessage()) + ")."); }

    @Override
    public void onResult(String h) {
        if (busy || h == null) return;
        String text;
        try { text = new JSONObject(h).optString("text").trim().toLowerCase(Locale.ROOT); } catch (Exception e) { text = ""; }
        if (text.isEmpty()) return;
        long now = System.currentTimeMillis();
        if (prior != null && now < priorUntil) { JSONObject p = prior; prior = null; process(text, p); return; }
        prior = null;
        if (now < commandUntil) { commandUntil = 0; process(text, null); return; }
        Matcher m = WAKE.matcher(text);
        if (!m.find()) return; // not for Aura: ignore and forget it
        String rest = m.group(1).trim();
        if (rest.isEmpty()) {
            commandUntil = now + 8000;
            busy = true;
            setStatus("Heard \"Hey Aura\". Say your task.");
            say("Yes?");
        } else process(rest, null);
    }

    private void process(String text, JSONObject p) {
        busy = true;
        if (speech != null) speech.setPause(true);
        setStatus("Working on it...");
        final Context ctx = this;
        Saver.run(this, text, p, new Hub.Cb() {
            public void done(JSONObject r) {
                String st = r.optString("status");
                String msg = r.optString("say", "Something went wrong. It was not added.");
                if ("saved".equals(st)) {
                    asks = 0;
                    long at = r.optLong("remindAt", 0);
                    if (at > 0) Reminders.schedule(ctx, r.optString("id", msg), r.optString("title", "Task"), at);
                    say(msg);
                } else if ("clarify".equals(st)) {
                    if (++asks > 3) { asks = 0; say("I still could not understand. Please open AuraStudent and add it there."); }
                    else {
                        try { prior = new JSONObject().put("why", r.optString("why")).put("text", r.optString("text")); } catch (Exception ignore) { }
                        priorUntil = System.currentTimeMillis() + 12000;
                        say(msg);
                    }
                } else if ("failed".equals(st)) {
                    asks = 0; Reminders.ensureChannel(ctx); notifyFailure(msg);
                    say(msg + " Open AuraStudent to add it yourself.");
                } else { asks = 0; say(msg); }
            }
        });
    }

    private void notifyFailure(String msg) {
        try {
            Notification n = new Notification.Builder(this, Reminders.CHANNEL).setSmallIcon(R.drawable.ic_stat)
                .setContentTitle("AuraStudent: task not added").setContentText(msg).setAutoCancel(true).build();
            getSystemService(NotificationManager.class).notify(12, n);
        } catch (Exception ignore) { }
    }
}
