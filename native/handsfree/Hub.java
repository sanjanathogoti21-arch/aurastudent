package app.aurastudent.planner;

import android.os.Handler;
import android.os.Looper;
import android.webkit.JavascriptInterface;
import org.json.JSONObject;

/** Receives the answer from the web app (auraHandsFree) and hands it to whoever asked. */
public class Hub {
    public interface Cb { void done(JSONObject r); }
    static volatile Cb pending;

    static void deliver(String json) {
        Cb cb = pending;
        pending = null;
        JSONObject obj;
        try {
            obj = new JSONObject(json);
        } catch (Exception e) {
            obj = new JSONObject();
            try { obj.put("status", "failed").put("say", "I could not save that. It was not added."); } catch (Exception ignore) { }
        }
        if (cb != null) cb.done(obj);
    }

    /** JavaScript calls AuraCb.done(json) from the page. */
    public static class CbJs {
        @JavascriptInterface
        public void done(final String json) {
            new Handler(Looper.getMainLooper()).post(new Runnable() { public void run() { deliver(json); } });
        }
    }

    /** Lets the web app know it is inside the Android app. */
    public static class AndroidInfo {
        @JavascriptInterface
        public String version() { return "1"; }
    }
}
