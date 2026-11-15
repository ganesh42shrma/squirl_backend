package app.squirl.sms;

import org.json.JSONArray;
import org.json.JSONObject;
import java.net.URI;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

final class PairingConfig {
    final String baseUrl, token;
    final List<Account> accounts;
    static final class Account {
        final String bank, last4;
        final Set<String> senders, headers = new HashSet<>();
        Account(String bank, String last4, Set<String> senders) {
            this.bank = bank; this.last4 = last4; this.senders = senders;
            for (String sender : senders) headers.add(BankFilter.header(sender));
        }
    }
    private PairingConfig(String baseUrl, String token, List<Account> accounts) { this.baseUrl = baseUrl; this.token = token; this.accounts = accounts; }

    static PairingConfig parse(String text) throws Exception {
        if (text.length() > 8000) throw new IllegalArgumentException();
        JSONObject json = new JSONObject(text);
        if (json.length() != 4 || !(json.get("version") instanceof Integer) || json.getInt("version") != 1) throw new IllegalArgumentException();
        URI url = new URI(json.getString("baseUrl"));
        String host = url.getHost();
        if (!"https".equals(url.getScheme()) || host == null || !host.matches("[a-zA-Z0-9-]+(?:\\.[a-zA-Z0-9-]+)*\\.ts\\.net")
                || url.getRawUserInfo() != null || url.getRawQuery() != null || url.getRawFragment() != null
                || (url.getPort() != -1 && url.getPort() != 443) || (url.getRawPath() != null && !url.getRawPath().isEmpty() && !url.getRawPath().equals("/"))) throw new IllegalArgumentException();
        String token = json.getString("token");
        if (!token.matches("[a-f0-9]{24}\\.[A-Za-z0-9_-]{43}")) throw new IllegalArgumentException();
        JSONArray list = json.getJSONArray("accounts");
        if (list.length() < 1 || list.length() > 2) throw new IllegalArgumentException();
        Set<String> banks = new HashSet<>();
        List<Account> accounts = new ArrayList<>();
        for (int i = 0; i < list.length(); i++) {
            JSONObject account = list.getJSONObject(i);
            String bank = account.getString("bank"), last4 = account.getString("last4");
            if (account.length() != 3 || !(bank.equals("sbi") || bank.equals("kotak")) || !banks.add(bank) || !last4.matches("[0-9]{4}")) throw new IllegalArgumentException();
            JSONArray ids = account.getJSONArray("senders");
            if (ids.length() < 1 || ids.length() > 10) throw new IllegalArgumentException();
            Set<String> senders = new HashSet<>();
            for (int n = 0; n < ids.length(); n++) {
                String sender = ids.getString(n).trim().toUpperCase(Locale.ROOT);
                if (!sender.matches("[A-Z0-9-]{2,32}")) throw new IllegalArgumentException();
                senders.add(sender);
            }
            accounts.add(new Account(bank, last4, senders));
        }
        return new PairingConfig("https://" + host.toLowerCase(Locale.ROOT), token, accounts);
    }
    String deviceId() { return token.substring(0, 24); }
}
