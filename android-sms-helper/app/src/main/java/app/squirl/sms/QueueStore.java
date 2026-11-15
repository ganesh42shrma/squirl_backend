package app.squirl.sms;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;

final class QueueStore extends SQLiteOpenHelper {
    QueueStore(Context context) { super(context, "sms-queue.db", null, 1); }
    @Override public void onCreate(SQLiteDatabase db) {
        db.execSQL("CREATE TABLE events(id TEXT PRIMARY KEY, device_id TEXT NOT NULL, payload BLOB, state TEXT NOT NULL, created_at INTEGER NOT NULL)");
    }
    @Override public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) { throw new IllegalStateException("Unsupported queue upgrade"); }
    void add(String deviceId, String id, String payload) throws Exception {
        getWritableDatabase().execSQL("INSERT OR IGNORE INTO events(id, device_id, payload, state, created_at) VALUES(?, ?, ?, 'pending', ?)",
                new Object[]{id, deviceId, CryptoBox.encrypt(SecretStore.key(), payload, "event:" + id), System.currentTimeMillis()});
    }
    static final class Event {
        final String id, payload;
        Event(String id, String payload) { this.id = id; this.payload = payload; }
    }
    Event next(String deviceId) throws Exception {
        try (Cursor cursor = getReadableDatabase().rawQuery("SELECT id, payload FROM events WHERE state = 'pending' AND device_id = ? ORDER BY created_at, rowid LIMIT 1", new String[]{deviceId})) {
            if (!cursor.moveToFirst()) return null;
            String id = cursor.getString(0);
            return new Event(id, CryptoBox.decrypt(SecretStore.key(), cursor.getBlob(1), "event:" + id));
        }
    }
    void acknowledged(String id) {
        ContentValues values = new ContentValues(); values.put("state", "sent"); values.putNull("payload");
        getWritableDatabase().update("events", values, "id = ?", new String[]{id});
    }
    void failed(String id) {
        ContentValues values = new ContentValues(); values.put("state", "failed");
        getWritableDatabase().update("events", values, "id = ?", new String[]{id});
    }
    int count(String state) {
        try (Cursor cursor = getReadableDatabase().rawQuery("SELECT count(*) FROM events WHERE state = ?", new String[]{state})) { cursor.moveToFirst(); return cursor.getInt(0); }
    }
    void retryFailed() { getWritableDatabase().execSQL("UPDATE events SET state = 'pending' WHERE state = 'failed'"); }
    void clear() { getWritableDatabase().delete("events", null, null); }
}
