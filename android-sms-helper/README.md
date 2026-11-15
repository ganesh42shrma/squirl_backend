# Squirl SMS companion

A small, personal Android helper for the existing Squirl PWA. The PWA remains the main app.
This APK only receives **new** SMS broadcasts, filters configured bank senders/account endings,
stores an encrypted local delivery queue, and posts to the private Tailscale HTTPS backend.
It does not read the inbox or import historical messages. There are no runtime third-party libraries,
analytics, LLM calls, public hosting, or foreground service.

## Build and run on Linux

1. Pull the updated **backend** repository. This Android project lives inside it at
   `squirl_backend/android-sms-helper`; do not create a new Android project.
2. In Android Studio, choose **Open** and select that folder. Allow the Gradle sync to finish.
3. Under **SDK Manager**, use SDK location `/home/ganesh-sharma/Android/Sdk` for this Linux setup.
   Install **Android 17 / API 37**, **Android SDK Build-Tools 36.0.0**, and **Android SDK Platform-Tools**
   if missing. Review and accept the Android SDK licenses in the setup UI yourself.
4. Under **Settings → Build, Execution, Deployment → Build Tools → Gradle**, use Android Studio’s
   embedded JDK / `jbr` as the Gradle JDK. The build requires Java 17 or newer.
5. On the Pixel, enable Developer options and USB debugging. Connect a data-capable USB cable,
   accept the debugging prompt for your own computer, select the Pixel in Studio, and press **Run**.
   No emulator or system-image download is needed.

The project pins Android Gradle Plugin 9.2.1 and the official Gradle 9.4.1 wrapper. The distribution
checksum is pinned in `gradle/wrapper/gradle-wrapper.properties`; the wrapper JAR was checked against
[Gradle’s published checksums](https://gradle.org/release-checksums/). First sync downloads dependencies.
The compatibility versions come from the [AGP 9.2 release notes](https://developer.android.com/build/releases/agp-9-2-0-release-notes).

After Studio has generated the ignored `local.properties` and the terminal has a working Java:

```bash
cd /home/ganesh-sharma/Desktop/development/alwaysOn/squirl_backend/android-sms-helper
./gradlew testDebugUnitTest lintDebug assembleDebug
```

APK output: `app/build/outputs/apk/debug/app-debug.apk`.
Studio’s **Build APK(s)** action can also produce it. APK output, SDK paths, IDE settings, and signing
keys are ignored by Git. Keep the same debug signing key to install updates over the existing helper;
uninstalling clears pairing and all unsent alerts. A personal debug build is not a Play Store release.

## Pair once the app is installed

1. Keep Tailscale connected on both phone and Linux. Open Squirl at its private `https://…ts.net` URL.
2. In **Profile → Bank SMS**, save the correct SBI / Kotak account endings and exact sender IDs.
   One account per bank is supported. The sender presets are editable; no account ending is prefilled.
3. Create a device such as **Pixel SMS helper**, then copy the one-time **pairing code**. Use the full
   pairing code, not just the token. Do not share it or place it in a URL.
4. In **Squirl SMS**, paste the code, review the displayed server/account/sender details, and save.
   The helper accepts only HTTPS `*.ts.net` origins, with no alternate ports, paths, or redirects.
5. Grant **incoming SMS** access and, on Android 17, **private network / Nearby devices** access.
   [Android 17 requires local-network permission](https://developer.android.com/privacy-and-security/local-network-permission)
   for affected private-network connections. Then enable **Capture and send bank alerts**.
6. Make a small, real UPI payment that triggers an SMS. Refresh the helper’s status, then refresh
   Squirl’s ledger or SMS review queue. A push-notification test does not test SMS capture.

`RECEIVE_SMS` is a dangerous, **hard-restricted** Android permission: the installer must allowlist it,
and the user must grant it. Use the Studio USB install for the first test. If SMS is unavailable or
cannot be granted in App permissions, stop there and inspect the installer/permission state rather
than assuming capture works. The app does not request default SMS-app status, `READ_SMS`, `SEND_SMS`,
contacts, accessibility, or notification access. See the [Android permission reference](https://developer.android.com/reference/android/Manifest.permission#RECEIVE_SMS).

## Delivery and privacy behavior

- Only exact configured senders and account endings pass the on-phone filter. OTP, one-time-password,
  verification-code, and UPI-PIN messages are excluded. Unrecognized text from a matching bank/account
  is sent for server review; it does not automatically become a ledger payment.
- The backend supports the supplied SBI UPI debit and Kotak UPI debit/credit formats. SBI credits
  and new formats need review until their parsers are implemented. Backend rules and reconciliation
  are described in [the SMS contract](../deployment/SMS.md).
- Pairing and queued payloads use AES-GCM with an Android Keystore key. Backup/device transfer are
  excluded. The UI blocks screenshots/recents previews and does not log message bodies or tokens.
  Android grants SMS reception broadly; filtering takes place inside this helper.
- A queued event keeps its original body, sender, receipt timestamp, and stable event ID for every
  retry. Acknowledgement deletes the local encrypted payload and retains only its hashed identifier,
  state, device identifier, and queue timestamp to prevent duplicate broadcast delivery.
- The queue is bound to the paired device. Re-pairing or forgetting clears local queued alerts.
  Pausing stops capture **and** delivery; a request already in flight may still reach the server.
  Revoke the device in Squirl to invalidate its server token. Password changes/reset also invalidate it.
- Network errors, 429s, and server errors retry with backoff. 401 stops capture and requires a fresh
  pairing. Other rejected requests are held for inspection; **Retry queued alerts** explicitly retries
  held items. Never repeatedly retry a conflict without checking Squirl first.
- Background jobs require connectivity and have a 15-minute periodic fallback. Android may defer
  them during Doze or battery saver, so delivery is not guaranteed to be immediate. Capture itself
  needs no permanent foreground service. Test with the screen locked before relying on it.
- Open the helper once after install/force-stop; unlock the phone once after reboot. Android can
  disable permissions for unused apps. Check the phone’s app battery/unused-app settings if delivery
  stops. Desktop/server uptime, mounted database drive, and Tailscale connectivity are still required.
- This version does not recover alerts received while capture was paused, the app was force-stopped,
  or the device was still locked after reboot. Compare against bank statements for completeness.
  Updating sender/account settings requires a fresh pairing code; revoke the old device first.

## Verification status

Ten JVM unit tests cover pairing restrictions, both banks’ provided formats, OTP/account/sender
filtering, stable device-scoped event identities, AES-GCM authentication, and HTTP acknowledgement /
retry / hold / re-pair behavior. All Java sources compile against an Android API 34 framework JAR
as an additional source check; the application targets API 37.

The current development Mac has no Android SDK. **A full Gradle APK build, Android lint, Keystore /
SQLite persistence, real permission grants, boot behavior, and locked-screen/offline delivery still
need verification on Linux and the Pixel.** Run the Gradle command above, then the physical checks:

- New matching SBI debit and Kotak debit/credit reach the ledger/review queue exactly once.
- Disconnect Tailscale, receive a bank alert, reopen/reboot the app, reconnect, and retry. The pending
  count should persist and drain without a duplicate ledger entry.
- Lock the phone, receive a bank alert, and verify background capture/delivery.
- Revoke the device in Squirl; the next attempted upload should stop capture and ask to pair again.
- Import the corresponding statement and verify that it reconciles the SMS entry in place.

Use your own bank account and a small test amount. Do not paste tokens, bank SMS text, or database
keys into issue logs or screenshots. Unit tests use fictional account endings and counterparties.
