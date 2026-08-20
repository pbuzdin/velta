package org.velta.coreservice;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.os.Binder;
import android.os.Build;
import android.os.IBinder;
import android.util.Log;

import androidx.core.app.NotificationCompat;

public class RpcService extends Service {
    private static final String TAG = "RpcService";
    private static final String CHANNEL_ID = "delta_core";
    private static final int NOTIFICATION_ID = 1;
    public static final String ACTION_STOP = "org.velta.coreservice.STOP";

    static {
        System.loadLibrary("rpc_core");
    }

    private final RpcBinder binder = new RpcBinder();
    private boolean started = false;

    public class RpcBinder extends Binder {
        public RpcService getService() {
            return RpcService.this;
        }
    }

    @Override
    public void onCreate() {
        super.onCreate();
        nativeInit();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            stopSelf();
            return START_NOT_STICKY;
        }

        if (!started) {
            started = true;
            String accountsDir = getFilesDir().getAbsolutePath() + "/accounts";
            nativeStart(accountsDir);
        }

        startForeground(NOTIFICATION_ID, buildNotification());
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        nativeStop();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return binder;
    }

    public void rpc(String jsonLine) {
        nativeRpc(jsonLine);
    }

    public void setRpcListener(RpcListener listener) {
        nativeSetRpcListener(listener);
    }

    private Notification buildNotification() {
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID,
                    "Delta Chat core",
                    NotificationManager.IMPORTANCE_LOW);
            nm.createNotificationChannel(channel);
        }

        Intent stopIntent = new Intent(this, RpcService.class);
        stopIntent.setAction(ACTION_STOP);
        PendingIntent stopPending = PendingIntent.getService(
                this,
                0,
                stopIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        return new NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle("Delta Chat core running")
                .setContentText("Background service is active")
                .setSmallIcon(android.R.drawable.ic_dialog_info)
                .addAction(android.R.drawable.ic_media_pause, "Stop", stopPending)
                .setOngoing(true)
                .build();
    }

    /* ---------------- JNI ---------------- */

    private native void nativeInit();
    private native void nativeStart(String accountsDir);
    private native void nativeStop();
    private native void nativeRpc(String jsonLine);
    private native void nativeSetRpcListener(RpcListener listener);

    public interface RpcListener {
        void onRpcMessage(String line);
    }
}
