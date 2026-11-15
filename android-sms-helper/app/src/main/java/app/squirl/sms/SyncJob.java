package app.squirl.sms;

import android.app.job.JobInfo;
import android.app.job.JobParameters;
import android.app.job.JobScheduler;
import android.app.job.JobService;
import android.content.ComponentName;
import android.content.Context;
import android.content.pm.PackageManager;
import android.os.Build;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicBoolean;
import javax.net.ssl.HttpsURLConnection;

public final class SyncJob extends JobService {
    static final String LOCAL_NETWORK = "android.permission.ACCESS_LOCAL_NETWORK";
    private static final int NOW = 2001, PERIODIC = 2002;
    private static final AtomicBoolean RUNNING = new AtomicBoolean();
    private final ConcurrentHashMap<Integer, Run> runs = new ConcurrentHashMap<>();
    private static final class Run {
        volatile boolean stopped;
        volatile HttpsURLConnection connection;
    }

    static boolean networkAllowed(Context context) {
        return Build.VERSION.SDK_INT < 37 || context.checkSelfPermission(LOCAL_NETWORK) == PackageManager.PERMISSION_GRANTED;
    }
    static void schedule(Context context) {
        if (!new SecretStore(context).enabled()) return;
        JobScheduler scheduler = context.getSystemService(JobScheduler.class);
        ComponentName service = new ComponentName(context, SyncJob.class);
        if (scheduler.getPendingJob(PERIODIC) == null) scheduler.schedule(new JobInfo.Builder(PERIODIC, service)
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY).setPersisted(true).setPeriodic(15 * 60_000L).build());
        if (scheduler.getPendingJob(NOW) == null) scheduler.schedule(new JobInfo.Builder(NOW, service)
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY).setPersisted(true)
                .setBackoffCriteria(30_000, JobInfo.BACKOFF_POLICY_EXPONENTIAL).build());
    }
    static void cancel(Context context) {
        JobScheduler scheduler = context.getSystemService(JobScheduler.class);
        scheduler.cancel(NOW); scheduler.cancel(PERIODIC);
    }

    @Override public boolean onStartJob(JobParameters params) {
        SecretStore secrets = new SecretStore(this);
        if (!secrets.enabled()) return false;
        if (!networkAllowed(this)) { secrets.status("Grant Nearby devices / local network access in the helper."); return false; }
        if (!RUNNING.compareAndSet(false, true)) return false;
        Run run = new Run();
        runs.put(params.getJobId(), run);
        new Thread(() -> {
            boolean retry = false;
            try { retry = drain(run); }
            catch (Exception ignored) {
                secrets.status("Delivery paused. Check pairing, storage, and permissions in the helper.");
            } finally {
                runs.remove(params.getJobId(), run);
                RUNNING.set(false);
                if (!run.stopped) jobFinished(params, retry);
            }
        }, "squirl-upload").start();
        return true;
    }
    @Override public boolean onStopJob(JobParameters params) {
        Run run = runs.get(params.getJobId());
        if (run != null) {
            run.stopped = true;
            if (run.connection != null) run.connection.disconnect();
        }
        return new SecretStore(this).enabled();
    }

    private boolean drain(Run run) throws Exception {
        SecretStore secrets = new SecretStore(this);
        try (QueueStore queue = new QueueStore(this)) {
            for (int n = 0; n < 25 && !run.stopped; n++) {
                PairingConfig config;
                QueueStore.Event event;
                synchronized (SecretStore.LOCK) {
                    if (!secrets.enabled() || !networkAllowed(this)) return false;
                    config = secrets.load();
                    if (config == null) return false;
                    event = queue.next(config.deviceId());
                    if (event == null) return false;
                }
                UploadPolicy.Action action;
                int code;
                try {
                    HttpsURLConnection connection = (HttpsURLConnection) new URL(config.baseUrl + "/api/sms/ingest").openConnection();
                    run.connection = connection;
                    if (run.stopped) return false;
                    connection.setInstanceFollowRedirects(false);
                    connection.setConnectTimeout(15_000); connection.setReadTimeout(20_000);
                    connection.setRequestMethod("POST"); connection.setDoOutput(true);
                    connection.setRequestProperty("Authorization", "Bearer " + config.token);
                    connection.setRequestProperty("X-Requested-With", "squirl");
                    connection.setRequestProperty("Content-Type", "application/json");
                    byte[] bytes = event.payload.getBytes(StandardCharsets.UTF_8);
                    connection.setFixedLengthStreamingMode(bytes.length);
                    try (OutputStream output = connection.getOutputStream()) { output.write(bytes); }
                    code = connection.getResponseCode();
                    action = UploadPolicy.classify(code, code >= 200 && code < 300 ? response(connection, code) : "");
                } catch (java.io.IOException ignored) {
                    synchronized (SecretStore.LOCK) {
                        if (samePairing(secrets, config)) secrets.status("Waiting for the private server. Keep Tailscale connected; queued alerts will retry.");
                    }
                    return true;
                } finally {
                    if (run.connection != null) run.connection.disconnect();
                    run.connection = null;
                }
                synchronized (SecretStore.LOCK) {
                    if (run.stopped || !samePairing(secrets, config)) return false;
                    if (action == UploadPolicy.Action.REPAIR) { secrets.authBlocked(); return false; }
                    if (action == UploadPolicy.Action.RETRY) { secrets.status("Server busy or unavailable. Queued alerts will retry."); return true; }
                    if (action == UploadPolicy.Action.HOLD) {
                        queue.failed(event.id);
                        secrets.status("An alert was held after HTTP " + code + ". Check Squirl before retrying.");
                    } else {
                        queue.acknowledged(event.id);
                        secrets.status("Alert delivered. Check Squirl’s ledger and SMS review queue.");
                    }
                }
            }
            return !run.stopped;
        }
    }
    private static boolean samePairing(SecretStore secrets, PairingConfig previous) throws Exception {
        PairingConfig current = secrets.load();
        return secrets.enabled() && current != null && current.token.equals(previous.token);
    }
    private static String response(HttpsURLConnection connection, int code) throws java.io.IOException {
        InputStream stream = code >= 400 ? connection.getErrorStream() : connection.getInputStream();
        if (stream == null) return "";
        try (InputStream input = stream; ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[1024];
            int size;
            while ((size = input.read(buffer)) != -1) {
                if (output.size() + size > 16_384) throw new java.io.IOException("Response too large");
                output.write(buffer, 0, size);
            }
            return output.toString(StandardCharsets.UTF_8.name());
        }
    }
}
