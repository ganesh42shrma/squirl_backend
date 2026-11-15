package app.squirl.sms;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.text.InputFilter;
import android.text.InputType;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.Switch;
import android.widget.TextView;
import android.widget.Toast;

public final class MainActivity extends Activity {
    private SecretStore secrets;
    private EditText pairing;
    private TextView status;
    private Switch capture;
    private boolean rendering;

    @Override public void onCreate(Bundle savedState) {
        super.onCreate(savedState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
        secrets = new SecretStore(this);
        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true); scroll.setBackgroundColor(Color.rgb(250, 248, 242));
        LinearLayout body = new LinearLayout(this);
        body.setOrientation(LinearLayout.VERTICAL); body.setPadding(dp(24), dp(20), dp(24), dp(28));
        scroll.addView(body);
        scroll.setOnApplyWindowInsetsListener((view, insets) -> {
            if (Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.ime());
                view.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            } else view.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(), insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
            return insets;
        });
        text(body, "Squirl SMS", 30);
        text(body, "A small companion for your Squirl PWA. Captures new bank SMS alerts and sends them to your private Linux server through Tailscale.", 17);
        text(body, "Only alerts matching your saved bank senders and account endings are queued. OTP messages are excluded. This helper does not read your SMS history.", 15);
        text(body, "1. Pair this phone", 21);
        text(body, "In Squirl → Profile → Bank SMS, save your SBI / Kotak account settings, create a device, and copy its pairing code. Paste that code below.", 16);
        pairing = new EditText(this);
        pairing.setHint("Private pairing code");
        pairing.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD | InputType.TYPE_TEXT_FLAG_MULTI_LINE);
        pairing.setMinLines(2); pairing.setMaxLines(4); pairing.setSaveEnabled(false);
        pairing.setFilters(new InputFilter[]{new InputFilter.LengthFilter(8000)});
        pairing.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO);
        body.addView(pairing, width());
        button(body, "Paste pairing code", () -> {
            ClipboardManager clipboard = getSystemService(ClipboardManager.class);
            ClipData clip = clipboard.getPrimaryClip();
            if (clip != null && clip.getItemCount() > 0 && clip.getItemAt(0).getText() != null) pairing.setText(clip.getItemAt(0).getText());
        });
        button(body, "Review and save pairing", this::savePairing);
        text(body, "2. Allow access", 21);
        button(body, "Allow incoming bank SMS", () -> requestPermissions(new String[]{Manifest.permission.RECEIVE_SMS}, 1));
        button(body, "Allow private network access", () -> {
            if (Build.VERSION.SDK_INT >= 37) requestPermissions(new String[]{SyncJob.LOCAL_NETWORK}, 2);
            else toast("This Android version does not need a separate local network permission.");
        });
        button(body, "Open app permission settings", () -> startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getPackageName()))));
        text(body, "3. Start capture", 21);
        capture = new Switch(this);
        capture.setText("Capture and send bank alerts"); capture.setTextSize(17);
        capture.setPadding(0, dp(16), 0, dp(16));
        capture.setOnCheckedChangeListener((view, enabled) -> {
            if (rendering) return;
            try {
                synchronized (SecretStore.LOCK) {
                    if (enabled && (secrets.load() == null || secrets.blocked() || !smsAllowed() || !SyncJob.networkAllowed(this))) {
                        toast("Pair this phone and grant both permissions first."); refresh(); return;
                    }
                    secrets.enable(enabled);
                    secrets.status(enabled ? "Capture enabled. Waiting for new bank alerts." : "Capture and delivery paused.");
                }
                if (enabled) SyncJob.schedule(this); else SyncJob.cancel(this);
            } catch (Exception ignored) { toast("Could not change capture. Check pairing and storage."); }
            refresh();
        });
        body.addView(capture, width());
        status = text(body, "", 16);
        button(body, "Refresh status", this::refresh);
        button(body, "Retry queued alerts", () -> {
            try {
                synchronized (SecretStore.LOCK) {
                    if (!secrets.enabled()) { toast("Enable capture first. If the token was rejected, pair again."); return; }
                    try (QueueStore queue = new QueueStore(this)) { queue.retryFailed(); }
                }
                SyncJob.schedule(this); refresh();
            } catch (Exception ignored) { toast("Could not retry. Check the helper’s storage."); }
        });
        button(body, "Open Squirl", () -> {
            try {
                PairingConfig config = secrets.load();
                if (config != null) startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(config.baseUrl + "/app/profile")));
                else toast("Pair this phone first.");
            } catch (Exception ignored) { toast("Could not open Squirl. Check the pairing."); }
        });
        button(body, "Forget pairing and local queue", () -> new AlertDialog.Builder(this)
                .setTitle("Forget this pairing?")
                .setMessage("This removes the helper’s pairing and unsent alerts. Revoke this device in Squirl → Profile → Bank SMS as well.")
                .setNegativeButton("Cancel", null).setPositiveButton("Forget", (dialog, which) -> {
                    try {
                        SyncJob.cancel(this);
                        synchronized (SecretStore.LOCK) {
                            secrets.enable(false);
                            try (QueueStore queue = new QueueStore(this)) { queue.clear(); }
                            secrets.clear();
                        }
                        pairing.setText(""); refresh();
                    } catch (Exception ignored) { toast("Could not clear local data. Capture is paused."); }
                }).show());
        text(body, "Keep Tailscale connected. Android may delay background work, especially in battery saver. Open this helper after installation or force-stop, and unlock the phone once after reboot. Start with a small real UPI payment and check the ledger / SMS review queue.", 15);
        setContentView(scroll);
        refresh();
    }
    private void savePairing() {
        final String code = pairing.getText().toString().trim();
        try {
            PairingConfig config = PairingConfig.parse(code);
            StringBuilder details = new StringBuilder(config.baseUrl);
            for (PairingConfig.Account account : config.accounts) details.append("\n\n").append(account.bank.toUpperCase(java.util.Locale.ROOT))
                    .append(" • ending ").append(account.last4).append("\n").append(String.join(", ", account.senders));
            details.append("\n\nSaving replaces the previous pairing and clears its local queue. Revoke the old device in Squirl if replacing one.");
            new AlertDialog.Builder(this).setTitle("Pair with this server?").setMessage(details.toString())
                    .setNegativeButton("Cancel", null).setPositiveButton("Save pairing", (dialog, which) -> {
                        try {
                            SyncJob.cancel(this);
                            synchronized (SecretStore.LOCK) {
                                secrets.save(code);
                                try (QueueStore queue = new QueueStore(this)) { queue.clear(); }
                            }
                            pairing.setText("");
                            ClipboardManager clipboard = getSystemService(ClipboardManager.class);
                            ClipData clip = clipboard.getPrimaryClip();
                            if (clip != null && clip.getItemCount() == 1 && code.contentEquals(clip.getItemAt(0).getText() == null ? "" : clip.getItemAt(0).getText())) {
                                if (Build.VERSION.SDK_INT >= 28) clipboard.clearPrimaryClip();
                                else clipboard.setPrimaryClip(ClipData.newPlainText("", ""));
                            }
                            refresh();
                        } catch (Exception ignored) { toast("Could not save pairing. Check the helper’s storage."); refresh(); }
                    }).show();
        } catch (Exception ignored) { toast("Invalid pairing code. Copy a fresh code from Squirl on your private HTTPS Tailscale address."); }
    }
    private boolean smsAllowed() { return checkSelfPermission(Manifest.permission.RECEIVE_SMS) == PackageManager.PERMISSION_GRANTED; }
    private void refresh() {
        if (status == null) return;
        rendering = true;
        capture.setChecked(secrets.enabled());
        rendering = false;
        try {
            PairingConfig config = secrets.load();
            StringBuilder text = new StringBuilder(config == null ? "Not paired" : "Server: " + config.baseUrl);
            if (config != null) for (PairingConfig.Account account : config.accounts) text.append("\n").append(account.bank.toUpperCase(java.util.Locale.ROOT)).append(" ending ").append(account.last4);
            text.append("\n\nSMS access: ").append(smsAllowed() ? "allowed" : "not allowed")
                    .append("\nPrivate network: ").append(SyncJob.networkAllowed(this) ? "allowed" : "not allowed");
            try (QueueStore queue = new QueueStore(this)) {
                text.append("\n\nWaiting: ").append(queue.count("pending")).append(" • Held: ").append(queue.count("failed")).append(" • Delivered: ").append(queue.count("sent"));
            }
            status.setText(text.append("\n\n").append(secrets.status()).toString());
        } catch (Exception ignored) { status.setText("Cannot read the pairing or queue. Re-pair if necessary; unsent alerts cannot be recovered after clearing app data."); }
    }
    @Override protected void onResume() { super.onResume(); if (secrets != null) { refresh(); SyncJob.schedule(this); } }
    @Override public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);
        refresh();
        if (results.length > 0 && results[0] != PackageManager.PERMISSION_GRANTED) toast("Permission not granted. Check App permissions; SMS access may be restricted by the installer.");
    }
    private TextView text(LinearLayout parent, String value, int size) {
        TextView view = new TextView(this); view.setText(value); view.setTextSize(size); view.setTextColor(Color.rgb(35, 35, 31));
        view.setPadding(0, dp(12), 0, dp(8)); parent.addView(view, width()); return view;
    }
    private void button(LinearLayout parent, String label, Runnable action) {
        Button button = new Button(this); button.setText(label); button.setAllCaps(false); button.setOnClickListener(view -> action.run());
        LinearLayout.LayoutParams params = width(); params.topMargin = dp(6); parent.addView(button, params);
    }
    private LinearLayout.LayoutParams width() { return new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT); }
    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
    private void toast(String message) { Toast.makeText(this, message, Toast.LENGTH_LONG).show(); }
}
