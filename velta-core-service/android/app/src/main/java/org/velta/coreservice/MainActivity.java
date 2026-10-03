package org.velta.coreservice;

import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;

public class MainActivity extends Activity {
    private static final int REQ_POST_NOTIFICATIONS = 1;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (Build.VERSION.SDK_INT >= 33) {
            if (checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS)
                    != PackageManager.PERMISSION_GRANTED) {
                requestPermissions(
                        new String[]{android.Manifest.permission.POST_NOTIFICATIONS},
                        REQ_POST_NOTIFICATIONS);
                return;
            }
        }
        startServiceAndFinish();
    }

    @Override
    public void onRequestPermissionsResult(
            int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQ_POST_NOTIFICATIONS) {
            startServiceAndFinish();
        }
    }

    private void startServiceAndFinish() {
        Intent intent = new Intent(this, RpcService.class);
        if (Build.VERSION.SDK_INT >= 26) {
            startForegroundService(intent);
        } else {
            startService(intent);
        }
        // V-01/#61: the bridges now require a per-start token. Surface it so
        // a loopback client (PWA) can be paired — paste it into the client's
        // localStorage key `velta-bridge-token`. Same process, so the static
        // JNI token is already valid.
        showBridgeToken();
    }

    private void showBridgeToken() {
        try {
            String token = RpcService.nativeGetBridgeToken();
            if (token == null || token.isEmpty()) return;
            new android.app.AlertDialog.Builder(this)
                    .setTitle("Bridge token")
                    .setMessage("Pair a loopback client (Velta PWA) by pasting this token:\n\n"
                            + token
                            + "\n\nIt changes every time the service restarts.")
                    .setPositiveButton("Copy", (d, w) -> {
                        android.content.ClipboardManager cm =
                                (android.content.ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
                        cm.setPrimaryClip(android.content.ClipData.newPlainText("Velta bridge token", token));
                        android.widget.Toast.makeText(this, "Token copied", android.widget.Toast.LENGTH_SHORT).show();
                    })
                    .setNegativeButton("Close", (d, w) -> finish())
                    .show();
        } catch (RuntimeException | UnsatisfiedLinkError e) {
            // Library load failed — the service itself surfaces that; don't
            // crash the launcher. Still finish so the launcher is reusable.
            finish();
        }
    }
}
