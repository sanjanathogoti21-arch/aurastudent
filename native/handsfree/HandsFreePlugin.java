package app.aurastudent.planner;

import android.Manifest;
import android.content.Intent;
import android.net.Uri;
import android.os.PowerManager;
import android.provider.Settings;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import com.getcapacitor.PermissionState;

/** Bridge between the web app (Profile > Hands-free) and the listening service. */
@CapacitorPlugin(name = "HandsFree", permissions = { @Permission(strings = { Manifest.permission.RECORD_AUDIO }, alias = "mic") })
public class HandsFreePlugin extends Plugin {

    @Override
    public void load() {
        ListenService.onStatus = new Runnable() { public void run() { notifyListeners("status", state()); } };
    }

    private JSObject state() {
        JSObject o = new JSObject();
        o.put("running", ListenService.running);
        o.put("status", ListenService.status);
        o.put("mic", getPermissionState("mic") == PermissionState.GRANTED);
        PowerManager pm = (PowerManager) getContext().getSystemService(android.content.Context.POWER_SERVICE);
        o.put("batteryOk", pm.isIgnoringBatteryOptimizations(getContext().getPackageName()));
        return o;
    }

    @PluginMethod
    public void status(PluginCall call) { call.resolve(state()); }

    @PluginMethod
    public void start(PluginCall call) {
        if (getPermissionState("mic") != PermissionState.GRANTED) {
            requestPermissionForAlias("mic", call, "micResult");
            return;
        }
        doStart(call);
    }

    @PermissionCallback
    private void micResult(PluginCall call) {
        if (getPermissionState("mic") == PermissionState.GRANTED) doStart(call);
        else {
            ListenService.setStatus("Microphone permission was denied, so hands-free cannot listen. You can allow it in Android Settings > Apps > AuraStudent > Permissions. Typing and the in-app mic still work.");
            call.resolve(state());
        }
    }

    private void doStart(PluginCall call) {
        try {
            getContext().startForegroundService(new Intent(getContext(), ListenService.class));
        } catch (Exception e) {
            ListenService.setStatus("Android did not allow listening to start: " + e.getMessage());
        }
        call.resolve(state());
    }

    @PluginMethod
    public void stop(PluginCall call) {
        getContext().startService(new Intent(getContext(), ListenService.class).setAction(ListenService.ACTION_STOP));
        call.resolve(state());
    }

    @PluginMethod
    public void openSettings(PluginCall call) {
        String what = call.getString("what", "app");
        Intent i;
        if ("battery".equals(what)) i = new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS);
        else i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getContext().getPackageName()));
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(i);
        call.resolve();
    }

    @Override
    protected void handleOnResume() { if (getBridge() != null) Saver.visible = new java.lang.ref.WeakReference<>(getBridge().getWebView()); }

    @Override
    protected void handleOnPause() { Saver.visible = null; }
}
