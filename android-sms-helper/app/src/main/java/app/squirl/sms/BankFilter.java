package app.squirl.sms;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Locale;
import java.util.regex.Pattern;

final class BankFilter {
    private static final Pattern SECRET = Pattern.compile("\\b(?:otp|one[ -]?time[ -]?(?:password|code)|verification[ -]code|upi[ -]?pin)\\b", Pattern.CASE_INSENSITIVE);
    // Indian DLT sender IDs look like "JM-KOTAKB-S": a 2-letter operator/circle prefix that varies by
    // network and roaming, the bank's registered header, and an optional 1-letter type suffix.
    // Only the header identifies the bank, so match on it and accept any prefix/suffix.
    private static final Pattern DLT = Pattern.compile("^(?:[A-Z]{2}-)?([A-Z0-9]{3,})(?:-[A-Z])?$");
    static String header(String sender) {
        String id = sender.trim().toUpperCase(Locale.ROOT);
        java.util.regex.Matcher m = DLT.matcher(id);
        return m.matches() ? m.group(1) : id;
    }
    static boolean accepts(PairingConfig config, String sender, String body) {
        if (sender == null || body == null || body.trim().isEmpty() || body.length() > 1500 || SECRET.matcher(body).find()) return false;
        String id = header(sender);
        for (PairingConfig.Account account : config.accounts) {
            if (account.headers.contains(id) && Pattern.compile("\\b(?:A/?C|account)\\s*(?:[Xx*]+\\s*)?" + account.last4 + "\\b", Pattern.CASE_INSENSITIVE).matcher(body).find()) return true;
        }
        return false;
    }
    static String eventId(String token, String sender, String body, long sentAt) throws Exception {
        String input = token.substring(0, 24) + "\n" + sender + "\n" + sentAt + "\n" + body;
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(input.getBytes(StandardCharsets.UTF_8));
        StringBuilder hex = new StringBuilder();
        for (byte b : digest) hex.append(String.format(Locale.ROOT, "%02x", b & 255));
        return hex.toString();
    }
}
