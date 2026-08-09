package com.goodfile.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;

public class TransferService extends Service {
    private static final String CHANNEL = "goodfile_transfer";
    private static final int NOTIFICATION_ID = 8080;
    private PowerManager.WakeLock wakeLock;

    public static void start(Context context, String fileName) {
        try {
            Intent intent = new Intent(context, TransferService.class);
            intent.putExtra("fileName", fileName);
            ContextCompat.startForegroundService(context, intent);
        } catch (RuntimeException ignored) {
            // Manufacturer policy may reject foreground services; foreground transfers still work.
        }
    }

    public static void stop(Context context) {
        context.stopService(new Intent(context, TransferService.class));
    }

    @Override public void onCreate() {
        super.onCreate();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(CHANNEL, "GoodFile transfers", NotificationManager.IMPORTANCE_LOW);
            getSystemService(NotificationManager.class).createNotificationChannel(channel);
        }
        PowerManager power = (PowerManager) getSystemService(POWER_SERVICE);
        wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "goodfile:transfer");
        wakeLock.acquire(60 * 60 * 1000L);
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        String fileName = intent == null ? "file" : intent.getStringExtra("fileName");
        Notification notification = new NotificationCompat.Builder(this, CHANNEL)
                .setSmallIcon(android.R.drawable.stat_sys_upload)
                .setContentTitle("GoodFile พร้อมส่ง")
                .setContentText(fileName == null ? "กำลังรอผู้รับ" : fileName)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .build();
        startForeground(NOTIFICATION_ID, notification);
        return START_NOT_STICKY;
    }

    @Override public void onDestroy() {
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        super.onDestroy();
    }

    @Override public IBinder onBind(Intent intent) { return null; }
}
