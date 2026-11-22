package app.aurastudent.planner;

import android.annotation.SuppressLint;
import android.content.Context;
import android.content.res.AssetManager;
import android.os.Handler;
import android.os.Looper;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import org.json.JSONObject;
import java.io.InputStream;
import java.lang.ref.WeakReference;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Runs the real AuraStudent web code (auraHandsFree) to understand and save a spoken task.
 * If the app screen is open it uses that page; otherwise a hidden copy of the same bundled app
 * (same address, https://localhost, so it reads and writes the same saved data) that is thrown away afterwards.
 */
public class Saver {
    interface Failer { void accept(String msg); }
    public static volatile WeakReference<WebView> visible;
    private static final Handler main = new Handler(Looper.getMainLooper());

    private static String mime(String p) {
        if (p.endsWith(".html")) return "text/html";
        if (p.endsWith(".js")) return "application/javascript";
        if (p.endsWith(".png")) return "image/png";
        if (p.endsWith(".webmanifest") || p.endsWith(".json")) return "application/json";
        if (p.endsWith(".css")) return "text/css";
        return "application/octet-stream";
    }

    @SuppressLint("SetJavaScriptEnabled")
    public static void run(final Context ctx, final String text, final JSONObject prior, final Hub.Cb done) {
        main.post(new Runnable() { public void run() { start(ctx, text, prior, done); } });
    }

    @SuppressLint("SetJavaScriptEnabled")
    private static void start(final Context ctx, String text, JSONObject prior, final Hub.Cb done) {
        final AtomicBoolean finished = new AtomicBoolean(false);
        final WebView[] hidden = new WebView[1];

        final Hub.Cb finish = new Hub.Cb() {
            public void done(final JSONObject r) {
                if (!finished.compareAndSet(false, true)) return;
                Hub.pending = null;
                if (hidden[0] != null) {
                    main.post(new Runnable() { public void run() { try { hidden[0].destroy(); } catch (Exception ignore) { } } });
                }
                done.done(r);
            }
        };
        final Failer failed = new Failer() {
            public void accept(String msg) {
                JSONObject o = new JSONObject();
                try { o.put("status", "failed").put("say", msg); } catch (Exception ignore) { }
                finish.done(o);
            }
        };

        Hub.pending = finish;
        final String script = "(function(){try{return auraHandsFree(" + JSONObject.quote(text) + "," +
            (prior == null ? "null" : prior.toString()) +
            ").then(function(r){AuraCb.done(JSON.stringify(r))})" +
            ".catch(function(e){AuraCb.done(JSON.stringify({status:'failed',say:'Something went wrong, so it was not added.'}))});}" +
            "catch(e){AuraCb.done(JSON.stringify({status:'failed',say:'Something went wrong, so it was not added.'}));}})();";

        WebView ui = visible == null ? null : visible.get();
        if (ui != null) {
            ui.evaluateJavascript(script, null);
        } else {
            final WebView w = new WebView(ctx.getApplicationContext());
            hidden[0] = w;
            w.getSettings().setJavaScriptEnabled(true);
            w.getSettings().setDomStorageEnabled(true);
            w.addJavascriptInterface(new Hub.CbJs(), "AuraCb");
            final AssetManager am = ctx.getAssets();
            w.setWebViewClient(new WebViewClient() {
                @Override
                public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
                    if (!"localhost".equals(req.getUrl().getHost())) return null;
                    String p = req.getUrl().getPath();
                    if (p == null || p.equals("/") || p.isEmpty()) p = "/index.html";
                    try {
                        InputStream in = am.open("public" + p);
                        return new WebResourceResponse(mime(p), "utf-8", in);
                    } catch (Exception e) {
                        return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", null, null);
                    }
                }

                @Override
                public void onPageFinished(final WebView view, String url) {
                    final int[] tries = {0};
                    final Runnable[] poll = new Runnable[1];
                    poll[0] = new Runnable() {
                        public void run() {
                            if (finished.get()) return;
                            view.evaluateJavascript("typeof window.auraHandsFree", new android.webkit.ValueCallback<String>() {
                                public void onReceiveValue(String v) {
                                    if (v != null && v.contains("function")) view.evaluateJavascript(script, null);
                                    else if (++tries[0] < 40) main.postDelayed(poll[0], 250);
                                    else failed.accept("I could not open AuraStudent to save it. It was not added. Please try again.");
                                }
                            });
                        }
                    };
                    poll[0].run();
                }
            });
            w.loadUrl("https://localhost/index.html");
        }
        main.postDelayed(new Runnable() { public void run() { failed.accept("Saving took too long, so the task was not added. Please try again."); } }, 30000);
    }
}
