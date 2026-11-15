package app.squirl.sms;

import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import javax.crypto.Cipher;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

final class CryptoBox {
    static byte[] encrypt(SecretKey key, String text, String purpose) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, key);
        cipher.updateAAD(purpose.getBytes(StandardCharsets.UTF_8));
        byte[] content = cipher.doFinal(text.getBytes(StandardCharsets.UTF_8));
        return ByteBuffer.allocate(12 + content.length).put(cipher.getIV()).put(content).array();
    }
    static String decrypt(SecretKey key, byte[] encoded, String purpose) throws Exception {
        if (encoded.length < 28) throw new IllegalArgumentException();
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(128, Arrays.copyOfRange(encoded, 0, 12)));
        cipher.updateAAD(purpose.getBytes(StandardCharsets.UTF_8));
        return new String(cipher.doFinal(Arrays.copyOfRange(encoded, 12, encoded.length)), StandardCharsets.UTF_8);
    }
}
