package app.squirl.sms;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import java.util.Arrays;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import static org.junit.Assert.*;

public class HelperCoreTest {
    private static final String TOKEN = "aaaaaaaaaaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    private static final String DEBIT = "Dear UPI user A/C X1111 debited by 1.00 on date 15Nov26 trf to TEST SHOP Refno 900000000001 If not u? call-1800111109 for other services-18001234-SBI";
    private static final String CREDIT = "Received Rs.1.00 in your Kotak Bank AC 2222 from TEST USER on 15-11-26.UPI Ref:900000000001";

    private JSONObject code() throws Exception {
        return new JSONObject().put("version", 1).put("baseUrl", "https://desktop.example-tailnet.ts.net").put("token", TOKEN)
                .put("accounts", new JSONArray()
                    .put(new JSONObject().put("bank", "sbi").put("last4", "1111").put("senders", new JSONArray().put("VK-SBIUPI-S").put("AD-SBIUPI-S")))
                    .put(new JSONObject().put("bank", "kotak").put("last4", "2222").put("senders", new JSONArray().put("JM-KOTAKB-S").put("JX-KOTAKB-S"))));
    }
    private void rejects(JSONObject value) {
        assertThrows(Exception.class, () -> PairingConfig.parse(value.toString()));
    }
    @Test public void pairingAcceptsPrivateHttpsAndBothConfiguredBanks() throws Exception {
        PairingConfig config = PairingConfig.parse(code().put("baseUrl", "https://DESKTOP.example-tailnet.ts.net:443/").toString());
        assertEquals("https://desktop.example-tailnet.ts.net", config.baseUrl);
        assertEquals(2, config.accounts.size());
        assertEquals("aaaaaaaaaaaaaaaaaaaaaaaa", config.deviceId());
    }
    @Test public void pairingRejectsUnsafeDestinations() throws Exception {
        for (String url : new String[]{"http://desktop.example-tailnet.ts.net", "https://example.com", "https://desktop.example-tailnet.ts.net.evil.com", "https://user@desktop.example-tailnet.ts.net", "https://desktop.example-tailnet.ts.net/path", "https://desktop.example-tailnet.ts.net?x=1", "https://desktop.example-tailnet.ts.net#x", "https://desktop.example-tailnet.ts.net:4000", "https://127.0.0.1"}) rejects(code().put("baseUrl", url));
    }
    @Test public void pairingRejectsInvalidTokensAndSchema() throws Exception {
        rejects(code().put("token", "not-a-token"));
        rejects(code().put("version", "1"));
        rejects(code().put("version", 1.2));
        rejects(code().put("unknown", true));
        rejects(code().put("accounts", new JSONArray()));
        JSONObject duplicate = code();
        duplicate.getJSONArray("accounts").getJSONObject(1).put("bank", "sbi");
        rejects(duplicate);
        JSONObject suffix = code(); suffix.getJSONArray("accounts").getJSONObject(0).put("last4", "111"); rejects(suffix);
        JSONObject sender = code(); sender.getJSONArray("accounts").getJSONObject(0).put("senders", new JSONArray().put(".*")); rejects(sender);
    }
    @Test public void filtersSbiDebitAndKotakCreditAndDebit() throws Exception {
        PairingConfig config = PairingConfig.parse(code().toString());
        assertTrue(BankFilter.accepts(config, "VK-SBIUPI-S", DEBIT));
        assertTrue(BankFilter.accepts(config, "ad-sbiupi-s", DEBIT));
        assertTrue(BankFilter.accepts(config, "JM-KOTAKB-S", CREDIT));
        assertTrue(BankFilter.accepts(config, "JX-KOTAKB-S", "Sent Rs.1.00 from Kotak Bank A/c X2222 to TEST USER on 15-11-26. UPI Ref 900000000002."));
    }
    @Test public void excludesOtpUnknownSenderAndDifferentAccounts() throws Exception {
        PairingConfig config = PairingConfig.parse(code().toString());
        assertFalse(BankFilter.accepts(config, "VK-SBIUPI-S", DEBIT + " OTP 123456"));
        assertFalse(BankFilter.accepts(config, "VK-SBIUPI-S", "Your one-time password for A/C X1111 is 123456"));
        assertFalse(BankFilter.accepts(config, "VK-SBIUPI-S", "Set UPI-PIN for A/C X1111 with code 123456"));
        assertFalse(BankFilter.accepts(config, "PERSONAL", DEBIT));
        assertFalse(BankFilter.accepts(config, "VK-SBIUPI-S", CREDIT));
        assertFalse(BankFilter.accepts(config, "VK-SBIUPI-S", DEBIT.replace("X1111", "X91111")));
        assertFalse(BankFilter.accepts(config, "VK-SBIUPI-S", DEBIT.replace("X1111", "X11110")));
        assertFalse(BankFilter.accepts(config, null, DEBIT));
    }
    @Test public void unknownBankTemplatesAreKeptForServerReview() throws Exception {
        assertTrue(BankFilter.accepts(PairingConfig.parse(code().toString()), "VK-SBIUPI-S", "A/C X1111 has a new transaction format not yet recognized."));
    }
    @Test public void eventIdentityIsStableAndBoundToDeviceAndSms() throws Exception {
        String id = BankFilter.eventId(TOKEN, "VK-SBIUPI-S", DEBIT, 1000L);
        assertTrue(id.matches("[a-f0-9]{64}"));
        assertEquals(id, BankFilter.eventId(TOKEN, "VK-SBIUPI-S", DEBIT, 1000L));
        assertNotEquals(id, BankFilter.eventId(TOKEN, "VK-SBIUPI-S", DEBIT, 1001L));
        assertNotEquals(id, BankFilter.eventId(TOKEN, "VK-SBIUPI-S", DEBIT + " changed", 1000L));
        assertNotEquals(id, BankFilter.eventId(TOKEN.replace('a', 'c'), "VK-SBIUPI-S", DEBIT, 1000L));
    }
    @Test public void encryptedPayloadsRoundTripWithRandomIv() throws Exception {
        KeyGenerator generator = KeyGenerator.getInstance("AES"); generator.init(256);
        SecretKey key = generator.generateKey();
        byte[] first = CryptoBox.encrypt(key, DEBIT, "event:1");
        byte[] second = CryptoBox.encrypt(key, DEBIT, "event:1");
        assertFalse(Arrays.equals(first, second));
        assertEquals(DEBIT, CryptoBox.decrypt(key, first, "event:1"));
        assertThrows(Exception.class, () -> CryptoBox.decrypt(key, first, "pairing"));
        first[first.length - 1] ^= 1;
        assertThrows(Exception.class, () -> CryptoBox.decrypt(key, first, "event:1"));
    }
    @Test public void terminalServerResultsAreAcknowledged() {
        for (String status : new String[]{"captured", "reconciled", "duplicate", "review", "ignored"})
            assertEquals(UploadPolicy.Action.ACKNOWLEDGE, UploadPolicy.classify(200, "{\"success\":true,\"data\":{\"status\":\"" + status + "\"}}"));
    }
    @Test public void uploadFailuresAreRetriedHeldOrRepaired() {
        assertEquals(UploadPolicy.Action.REPAIR, UploadPolicy.classify(401, ""));
        for (int code : new int[]{408, 429, 500, 503}) assertEquals(UploadPolicy.Action.RETRY, UploadPolicy.classify(code, ""));
        for (int code : new int[]{301, 302, 400, 403, 404, 409}) assertEquals(UploadPolicy.Action.HOLD, UploadPolicy.classify(code, ""));
        assertEquals(UploadPolicy.Action.RETRY, UploadPolicy.classify(200, "<html>proxy error</html>"));
        assertEquals(UploadPolicy.Action.RETRY, UploadPolicy.classify(200, "{\"success\":true,\"data\":{\"status\":\"unknown\"}}"));
    }
}
