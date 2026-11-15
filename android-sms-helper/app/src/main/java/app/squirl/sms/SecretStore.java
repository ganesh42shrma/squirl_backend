package app.squirl.sms;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import java.security.KeyStore;
import java.util.Base64;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;

final class SecretStore {
    static final Object LOCK = new Object();
    private static final String ALIAS = "squirl-sms-v1";
    private final SharedPreferences prefs;
    SecretStore(Context context) { prefs = context.getSharedPreferences("bridge", Context.MODE_PRIVATE); }

    static synchronized SecretKey key() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (!store.containsAlias(ALIAS)) {
            KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
            generator.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setKeySize(256).build());
            generator.generateKey();
        }
        return (SecretKey) store.getKey(ALIAS, null);
    }
    PairingConfig load() throws Exception {
        String data = prefs.getString("pairing", null);
        return data == null ? null : PairingConfig.parse(CryptoBox.decrypt(key(), Base64.getDecoder().decode(data), "pairing"));
    }
    void save(String code) throws Exception {
        PairingConfig.parse(code);
        String data = Base64.getEncoder().encodeToString(CryptoBox.encrypt(key(), code, "pairing"));
        if (!prefs.edit().putString("pairing", data).putBoolean("capture", false).putBoolean("authBlocked", false).putString("status", "Paired. Grant permissions, then enable capture.").commit()) throw new IllegalStateException();
    }
    boolean enabled() { return prefs.getBoolean("capture", false) && !blocked(); }
    boolean blocked() { return prefs.getBoolean("authBlocked", false); }
    void enable(boolean value) { prefs.edit().putBoolean("capture", value).apply(); }
    void authBlocked() { prefs.edit().putBoolean("authBlocked", true).putBoolean("capture", false).putString("status", "Device token rejected. Revoke the old device in Squirl and pair again.").apply(); }
    void status(String message) { prefs.edit().putString("status", message).apply(); }
    String status() { return prefs.getString("status", "Not paired yet."); }
    void clear() { if (!prefs.edit().clear().commit()) throw new IllegalStateException(); }
}
