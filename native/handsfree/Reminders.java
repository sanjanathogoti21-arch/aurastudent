package app.aurastudent.planner;

import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Phone notification for a task that was added by voice while the app was closed. */
public class Reminders {
    public static final String CHANNEL = "reminders";

    public static void ensureChannel(Context ctx) {
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        if (nm.getNotificationChannel(CHANNEL) == null)
            nm.createNotificationChannel(new NotificationChannel(CHANNEL, "Task reminders", NotificationManager.IMPORTANCE_HIGH));
    }

    /** Not exact to the second: Android may delay it a little to save battery. */
    public static void schedule(Context ctx, String id, String title, long atMs) {
        if (atMs <= System.currentTimeMillis()) return;
        AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
        Intent i = new Intent(ctx, ReminderReceiver.class).putExtra("title", title).putExtra("id", id);
        PendingIntent pi = PendingIntent.getBroadcast(ctx, id.hashCode(), i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, atMs, pi);
    }

    public static class ReminderReceiver extends BroadcastReceiver {
        @Override
        public void onReceive(Context ctx, Intent intent) {
            ensureChannel(ctx);
            String title = intent.getStringExtra("title");
            if (title == null) title = "Task";
            Intent launch = ctx.getPackageManager().getLaunchIntentForPackage(ctx.getPackageName());
            PendingIntent open = PendingIntent.getActivity(ctx, 0, launch, PendingIntent.FLAG_IMMUTABLE);
            Notification n = new Notification.Builder(ctx, CHANNEL)
                .setSmallIcon(R.drawable.ic_stat)
                .setContentTitle("AuraStudent reminder")
                .setContentText(title)
                .setAutoCancel(true)
                .setContentIntent(open)
                .build();
            try {
                String id = intent.getStringExtra("id");
                ctx.getSystemService(NotificationManager.class).notify((id == null ? title : id).hashCode(), n);
            } catch (SecurityException ignore) { }
        }
    }
}
