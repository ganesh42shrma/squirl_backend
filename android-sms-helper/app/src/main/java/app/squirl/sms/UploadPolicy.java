package app.squirl.sms;

import org.json.JSONObject;

final class UploadPolicy {
    enum Action { ACKNOWLEDGE, RETRY, HOLD, REPAIR }
    static Action classify(int code, String response) {
        if (code == 401) return Action.REPAIR;
        if (code == 408 || code == 429 || code >= 500) return Action.RETRY;
        if (code < 200 || code >= 300) return Action.HOLD;
        try {
            JSONObject json = new JSONObject(response);
            if (!json.getBoolean("success")) return Action.RETRY;
            String status = json.getJSONObject("data").getString("status");
            if (status.equals("captured") || status.equals("reconciled") || status.equals("duplicate") || status.equals("review") || status.equals("ignored")) return Action.ACKNOWLEDGE;
        } catch (Exception ignored) { }
        return Action.RETRY;
    }
}
