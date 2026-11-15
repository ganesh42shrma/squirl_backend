# Photo attachments (receipts and other pictures)

You can attach photos to transactions, tasks and goals. The pictures are encrypted by the app and stored on the
Linux laptop's **internal disk**, never on the database USB drive and never inside the database. Optionally an
encrypted copy is also kept in S3-compatible cloud storage as a backup.

**This release starts normally with media switched off.** Nothing below is needed for the app to boot or for
`/api/health` to pass. Until media is configured, photo screens show a short "not set up" hint and every
`/api/media/*` route (except `/api/media/status`) answers `503 MEDIA_NOT_CONFIGURED`.

## What is stored where

| What | Where |
| --- | --- |
| Picture bytes | `MEDIA_DIR/<2 characters>/<random id>.sqm` on the laptop, AES-256-GCM encrypted, mode 0600 |
| Which picture belongs to which item | The encrypted SQLite database (tables `media`, `attachments`) |
| Optional copy | `media/<random id>.sqm` in your bucket: the same encrypted bytes, nothing readable |
| The key that decrypts pictures | `MEDIA_KEY` in the laptop's production `.env`, and your own backup of it |

No original file name is ever stored or sent anywhere. The browser shrinks photos (max 2000 px, JPEG) and removes
camera metadata such as GPS before upload.

## Set it up on the Linux laptop

1. Make a folder on the **internal** disk, outside the database folder:

   ```bash
   mkdir -p /home/ganesh-sharma/squirl-media
   chmod 700 /home/ganesh-sharma/squirl-media
   ```

   The app refuses (and logs a warning) if `MEDIA_DIR` is inside the folder that holds `DB_PATH`.

2. Generate a key (32 random bytes):

   ```bash
   openssl rand -base64 32
   ```

3. **Back the key up somewhere other than this laptop** (password manager, printed copy in a safe place).
   **If `MEDIA_KEY` is lost, every stored picture is unrecoverable**, including the copies in S3. Changing
   `MEDIA_KEY` later makes existing pictures unreadable (they answer `MEDIA_UNREADABLE`), so treat it like the
   database key.

4. Add both to the production `.env` (the one on the internal disk, never on the USB drive):

   ```
   MEDIA_DIR=/home/ganesh-sharma/squirl-media
   MEDIA_KEY=<the base64 value from step 2>
   ```

5. Restart the service and check the log:

   ```bash
   systemctl --user restart squirl.service
   journalctl --user -u squirl.service -n 50 --no-pager
   ```

   If something is wrong you get one warning line (for example "MEDIA_KEY must be 32 random bytes") and the app
   keeps running with photos off. The key is never written to the log.

Optional limits (defaults in brackets): `MEDIA_MAX_BYTES` (8388608, per photo), `MEDIA_USER_QUOTA_BYTES`
(5368709120, per account), `MEDIA_MAX_PER_OWNER` (10, per transaction/task/goal).

## Optional: encrypted copy in S3-compatible storage

Only switched on when all four of `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` are
set. The endpoint must be `https://`. The app signs requests itself (AWS Signature V4); no extra software is
installed. Give the access key permission to read, write and delete objects in that one bucket only.

Cloudflare R2:

```
S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
S3_BUCKET=squirl-media
S3_REGION=auto
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
S3_PATH_STYLE=true
```

Backblaze B2 (S3 API; use the endpoint and region shown for your bucket):

```
S3_ENDPOINT=https://s3.us-west-004.backblazeb2.com
S3_BUCKET=squirl-media
S3_REGION=us-west-004
S3_ACCESS_KEY_ID=<keyID>
S3_SECRET_ACCESS_KEY=<applicationKey>
S3_PATH_STYLE=true
```

How the copy behaves:

- After each upload the picture is marked `pending` and copied in the background, one at a time. A slow or
  failing bucket never fails or slows the person's upload.
- Failures are retried with a growing pause (1 min, 2, 4 ... up to 6 hours) and give up after 8 tries
  (`replica_state = 'failed'`). A restart or the 6-hourly pass does not reset the count.
- Pictures stored before S3 was switched on are copied the next time the background pass runs.
- Removing a picture deletes its local file and its copy. If S3 is unreachable the removal is remembered
  (`pending_delete`) and retried.
- If a local file goes missing and the copy exists, opening the picture fetches it from S3, checks it, and
  restores the local file.
- Removed pictures disappear from your account straight away. Deleting a whole account deletes remote copies in
  one background pass; if S3 is down at that moment those objects stay in the bucket (they are unreadable
  without the key, and can be deleted by hand under `media/`).

## Housekeeping

At start-up and every 6 hours the app removes pictures nothing is attached to, and stray files nothing owns, but
only once they are more than a day old. It only touches files named like `<24 hex characters>.sqm` in the
two-character folders, so other files in the folder are left alone.

"Start fresh" (reset financial data) also deletes the photos on transactions and goals. Photos on tasks are kept.
Deleting a task, goal or transaction hides its photos; restoring it brings them back.

## Backup and restore

- **Back up** the `MEDIA_DIR` folder (it is already encrypted, so any backup location is fine) together with the
  database backup, and keep `MEDIA_KEY` in a separate safe place. With S3 switched on the bucket is a second copy.
- **Restore on a new laptop:**
  1. Restore the database and its `DB_KEY` as usual.
  2. Copy the backed-up folder to the new `MEDIA_DIR` (or leave it empty if S3 has the copies).
  3. Put the **same** `MEDIA_KEY` in the new `.env` and start the service.
  4. With S3 configured, any picture whose local file is missing is fetched back the first time it is opened.
     Without S3, a missing file shows as a broken photo until the folder is restored.

A picture can only be opened with the key that saved it. A wrong key never shows garbage: the photo fails with
an error instead.

## Checks

```bash
cd squirl_backend && npm run test:media   # hermetic: temp folders, in-memory DB, local fake S3
```
