package app.squirl.sms;

import android.Manifest;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.provider.Telephony;
import android.telephony.SmsMessage;
import org.json.JSONObject;
import java.time.Instant;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class SmsReceiver extends BroadcastReceiver {
    private static final ExecutorService IO = Executors.newSingleThreadExecutor();
    @Override public void onReceive(Context context, Intent intent) {
        if (!Telephony.Sms.Intents.SMS_RECEIVED_ACTION.equals(intent.getAction()) || context.checkSelfPermission(Manifest.permission.RECEIVE_SMS) != PackageManager.PERMISSION_GRANTED) return;
        final Context app = context.getApplicationContext();
        final PendingResult pending = goAsync();
        IO.execute(() -> {
            SecretStore secrets = new SecretStore(app);
            try {
                synchronized (SecretStore.LOCK) {
                if (!secrets.enabled()) return;
                PairingConfig config = secrets.load();
                if (config == null) return;
                SmsMessage[] parts = Telephony.Sms.Intents.getMessagesFromIntent(intent);
                if (parts == null || parts.length == 0 || parts[0].getOriginatingAddress() == null) return;
                String sender = parts[0].getOriginatingAddress().trim().toUpperCase(Locale.ROOT);
                StringBuilder joined = new StringBuilder();
                for (SmsMessage part : parts) {
                    if (part.getOriginatingAddress() == null || !sender.equals(part.getOriginatingAddress().trim().toUpperCase(Locale.ROOT))) return;
                    if (part.getMessageBody() != null) joined.append(part.getMessageBody());
                }
                String body = joined.toString().trim();
                if (!BankFilter.accepts(config, sender, body)) return;
                String id = BankFilter.eventId(config.token, sender, body, parts[0].getTimestampMillis());
                String payload = new JSONObject().put("eventId", id).put("sender", sender).put("body", body).put("receivedAt", Instant.now().toString()).toString();
                try (QueueStore queue = new QueueStore(app)) { queue.add(config.deviceId(), id, payload); }
                secrets.status("Bank alert queued for Squirl.");
                }
                SyncJob.schedule(app);
            } catch (Exception e) {
                secrets.status("Could not queue a bank alert. Open the helper and check its pairing and storage.");
            } finally { pending.finish(); }
        });
    }
}
