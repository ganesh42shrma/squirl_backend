// Photo attachments: who may add, see and remove which image. The bytes live in the encrypted store
// (media.store.js); the database only holds metadata. EVERY query is scoped by user_id.
const { createHash } = require('node:crypto');
const { getDb } = require('../../config/db');
const AppError = require('../../core/AppError');
const logger = require('../../core/logger');
const { newId, nowIso, insertRow, placeholders } = require('../../core/sql');
const runtime = require('./media.runtime');
const { inspectImage, dimensionsAllowed, MAX_SIDE, EXTENSIONS } = require('./media.image');
const replica = require('./media.replica');

const ORPHAN_AGE_MS = 24 * 60 * 60 * 1000;
const { OWNER_VIEWS } = require('./media.owners');

// SQL: "attachment alias `a` points at an owner that is still live and belongs to the same account".
const liveOwner = (a) => `(${Object.entries(OWNER_VIEWS).map(([type, view]) =>
  `(${a}.owner_type = '${type}' AND EXISTS (SELECT 1 FROM ${view} o WHERE o.id = ${a}.owner_id AND o.user_id = ${a}.user_id))`).join(' OR ')})`;

function requireConfigured() {
  const rt = runtime.get();
  if (!rt.configured) {
    throw AppError.serviceUnavailable('Photo attachments aren’t set up on this server yet.', 'MEDIA_NOT_CONFIGURED');
  }
  return rt;
}

const status = () => {
  const rt = runtime.get();
  return rt.configured
    ? { configured: true, maxBytes: rt.maxBytes, maxPerOwner: rt.maxPerOwner }
    : { configured: false };
};

const toAttachment = (row) => ({
  id: row.id,
  mediaId: row.media_id,
  ownerType: row.owner_type,
  ownerId: row.owner_id,
  day: row.day ?? undefined,
  mime: row.mime,
  size: row.size_bytes,
  width: row.width,
  height: row.height,
  createdAt: row.created_at,
});

const ATTACHMENT_SELECT = `SELECT a.id, a.media_id, a.owner_type, a.owner_id, a.day, a.created_at, m.mime, m.size_bytes, m.width, m.height
  FROM active_attachments a JOIN active_media m ON m.id = a.media_id AND m.user_id = a.user_id`;

// 404 for "no such thing" and "someone else's thing" alike, so ids can't be probed.
function assertOwner(db, userId, ownerType, ownerId) {
  const view = OWNER_VIEWS[ownerType];
  if (!view || !db.prepare(`SELECT 1 FROM ${view} WHERE id = ? AND user_id = ?`).get(ownerId, userId)) {
    throw AppError.notFound('That item was not found', 'MEDIA_OWNER_NOT_FOUND');
  }
}

// The limit is per item, and per day for a habit (a daily habit collects a photo every day, for years).
const ownerAttachmentCount = (db, userId, ownerType, ownerId, day) =>
  db.prepare('SELECT count(*) FROM active_attachments WHERE user_id = ? AND owner_type = ? AND owner_id = ? AND day IS ?').pluck().get(userId, ownerType, ownerId, day ?? null);

function listAttachments(userId, { ownerType, ownerId, day }) {
  requireConfigured();
  const db = getDb();
  assertOwner(db, userId, ownerType, ownerId);
  return db.prepare(`${ATTACHMENT_SELECT} WHERE a.user_id = ? AND a.owner_type = ? AND a.owner_id = ?${day ? ' AND a.day = ?' : ''} ORDER BY a.rowid`)
    .all(userId, ownerType, ownerId, ...(day ? [day] : [])).map(toAttachment);
}

/**
 * Stores one image and attaches it. Returns { attachment, created }: created is false when this exact picture
 * was already attached to this item (nothing changes then).
 * The file is written BEFORE the rows, and removed again if the rows can't be written, so a row never points
 * at a missing file. Everything after the rate limit is synchronous, so two uploads can't interleave.
 */
function upload(userId, { ownerType, ownerId, day, buffer }) {
  const rt = requireConfigured();
  const db = getDb();

  // Trust the bytes, not the client: the type and size come from the file's own header.
  const info = inspectImage(buffer);
  if (!info) throw AppError.badRequest('That file isn’t a photo we can use. Please choose a JPEG, PNG or WebP image.', 'INVALID_IMAGE');
  if (!dimensionsAllowed(info)) {
    throw AppError.badRequest(`That photo is too large in pixels (the limit is ${MAX_SIDE} px on a side).`, 'IMAGE_DIMENSIONS_TOO_LARGE');
  }
  assertOwner(db, userId, ownerType, ownerId);

  const sha256 = createHash('sha256').update(buffer).digest('hex');
  const existing = db.prepare('SELECT * FROM active_media WHERE user_id = ? AND sha256 = ?').get(userId, sha256);
  if (existing) {
    const attached = db.prepare(`${ATTACHMENT_SELECT} WHERE a.user_id = ? AND a.owner_type = ? AND a.owner_id = ? AND a.media_id = ?`)
      .get(userId, ownerType, ownerId, existing.id);
    if (attached && (attached.day ?? null) === (day ?? null)) return { attachment: toAttachment(attached), created: false };
    // One picture can't prove two days of the same habit.
    if (attached) throw AppError.conflict('You already used that photo for another day. Take a new one.', 'MEDIA_ALREADY_USED');
  }
  if (ownerAttachmentCount(db, userId, ownerType, ownerId, day) >= rt.maxPerOwner) {
    throw AppError.conflict(`You can attach up to ${rt.maxPerOwner} photos here. Remove one to add another.`, 'MEDIA_LIMIT_REACHED');
  }

  const now = nowIso();
  const attachmentId = newId();
  if (existing) {
    // Same picture, already stored for this account: no new file, no new quota. If its file has gone missing
    // we hold the bytes right now, so put it back.
    if (!rt.store.exists(existing.id)) rt.store.put(existing.id, userId, buffer);
    insertRow(db, 'attachments', { id: attachmentId, user_id: userId, media_id: existing.id, owner_type: ownerType, owner_id: ownerId, day: day ?? null, created_at: now });
    return { attachment: toAttachment(db.prepare(`${ATTACHMENT_SELECT} WHERE a.id = ? AND a.user_id = ?`).get(attachmentId, userId)), created: true };
  }

  const used = db.prepare('SELECT ifnull(sum(size_bytes), 0) FROM active_media WHERE user_id = ?').pluck().get(userId);
  if (used + buffer.length > rt.userQuotaBytes) {
    throw new AppError('You’ve reached your photo storage limit. Remove some photos to add more.', 413, 'MEDIA_QUOTA_EXCEEDED');
  }

  const mediaId = newId();
  rt.store.put(mediaId, userId, buffer);
  try {
    db.transaction(() => {
      insertRow(db, 'media', {
        id: mediaId, user_id: userId, sha256, mime: info.mime, size_bytes: buffer.length,
        width: info.width, height: info.height, replica_state: rt.s3 ? 'pending' : 'none', created_at: now, updated_at: now,
      });
      insertRow(db, 'attachments', { id: attachmentId, user_id: userId, media_id: mediaId, owner_type: ownerType, owner_id: ownerId, day: day ?? null, created_at: now });
    })();
  } catch (err) {
    try { rt.store.remove(mediaId); } catch (cleanup) { logger.warn('Could not remove a photo file after a failed save', { error: cleanup.code || cleanup.name }); }
    throw err;
  }
  if (rt.s3) replica.nudge();
  return { attachment: toAttachment(db.prepare(`${ATTACHMENT_SELECT} WHERE a.id = ? AND a.user_id = ?`).get(attachmentId, userId)), created: true };
}

/**
 * The image bytes for one picture. Rule: the picture belongs to this account AND it has a live attachment to an
 * item that still exists (a deleted task/goal/transaction hides its photos until it is restored).
 * A missing local file is fetched back from the S3 copy when there is one, and the local copy is rewritten.
 */
async function openFile(userId, mediaId) {
  const rt = requireConfigured();
  const db = getDb();
  const row = db.prepare(`SELECT m.* FROM active_media m WHERE m.id = ? AND m.user_id = ? AND EXISTS (
      SELECT 1 FROM active_attachments a WHERE a.media_id = m.id AND a.user_id = m.user_id AND ${liveOwner('a')})`).get(mediaId, userId);
  if (!row) throw AppError.notFound('Photo not found', 'MEDIA_NOT_FOUND');

  let buffer;
  try {
    buffer = rt.store.get(row.id, userId);
  } catch (err) {
    if (err.code !== 'MEDIA_FILE_MISSING') throw err; // unreadable stays an error: never serve garbage
    buffer = await healFromReplica(rt, row, userId, err);
  }
  return { buffer, mime: row.mime, extension: EXTENSIONS[row.mime] };
}

async function healFromReplica(rt, row, userId, notFound) {
  if (!rt.s3 || row.replica_state !== 'done') throw notFound;
  let bytes;
  try {
    bytes = await rt.s3.get(replica.objectKey(row.id));
  } catch (err) {
    logger.warn('Could not fetch a photo from the S3 copy', { error: err.message });
    throw notFound;
  }
  if (!bytes) throw notFound;
  const plain = rt.store.decode(row.id, userId, bytes); // throws MEDIA_UNREADABLE if the copy isn't this photo
  try { rt.store.writeRaw(row.id, bytes); } catch (err) { logger.warn('Could not restore a photo file from the S3 copy', { error: err.code || err.name }); }
  return plain;
}

/**
 * Marks pictures with no live attachment left as deleted (inside the caller's transaction) and returns what
 * must be cleaned outside it. A picture still on another item (the same photo attached twice) is kept.
 */
function releaseMedia(db, userId, mediaIds, now = nowIso()) {
  const released = [];
  for (const id of mediaIds) {
    const stillUsed = db.prepare('SELECT 1 FROM active_attachments WHERE user_id = ? AND media_id = ?').get(userId, id);
    if (stillUsed) continue;
    // 'pending_delete' keeps the row so the remote copy is removed even if S3 is down right now.
    const changed = db.prepare(`UPDATE media SET deleted_at = ?, updated_at = ?, replica_attempts = 0,
      replica_state = CASE WHEN replica_state = 'none' THEN 'none' ELSE 'pending_delete' END
      WHERE id = ? AND user_id = ? AND deleted_at IS NULL`).run(now, now, id, userId).changes;
    if (changed) released.push({ id, userId });
  }
  return released;
}

/** Soft-detaches every live attachment of the given owner types (financial reset). Returns files to purge. */
function detachOwnerTypes(db, userId, ownerTypes, now = nowIso()) {
  const marks = placeholders(ownerTypes);
  const ids = db.prepare(`SELECT DISTINCT media_id FROM active_attachments WHERE user_id = ? AND owner_type IN (${marks})`).pluck().all(userId, ...ownerTypes);
  db.prepare(`UPDATE attachments SET deleted_at = ? WHERE user_id = ? AND deleted_at IS NULL AND owner_type IN (${marks})`).run(now, userId, ...ownerTypes);
  return releaseMedia(db, userId, ids, now);
}

/**
 * Moves every live photo on one item to another (inside the caller's transaction): a capture inbox note that is
 * sorted into a payment or task takes its photos with it. A picture the target already has is just dropped from
 * the source. Ownership of both items is the caller's responsibility (it has just created or loaded them).
 */
function moveAttachments(db, userId, from, to) {
  const rows = db.prepare('SELECT id, media_id FROM active_attachments WHERE user_id = ? AND owner_type = ? AND owner_id = ?')
    .all(userId, from.type, from.id);
  const already = db.prepare('SELECT 1 FROM active_attachments WHERE user_id = ? AND owner_type = ? AND owner_id = ? AND media_id = ?');
  const now = nowIso();
  for (const row of rows) {
    if (already.get(userId, to.type, to.id, row.media_id)) db.prepare('UPDATE attachments SET deleted_at = ? WHERE id = ?').run(now, row.id);
    else db.prepare('UPDATE attachments SET owner_type = ?, owner_id = ? WHERE id = ?').run(to.type, to.id, row.id);
  }
  return rows.length;
}

/** Detaches every photo on one item (inside the caller's transaction) and returns the files to purge afterwards. */
function detachOwner(db, userId, ownerType, ownerId, now = nowIso()) {
  const ids = db.prepare('SELECT DISTINCT media_id FROM active_attachments WHERE user_id = ? AND owner_type = ? AND owner_id = ?')
    .pluck().all(userId, ownerType, ownerId);
  if (!ids.length) return [];
  db.prepare('UPDATE attachments SET deleted_at = ? WHERE user_id = ? AND owner_type = ? AND owner_id = ? AND deleted_at IS NULL').run(now, userId, ownerType, ownerId);
  return releaseMedia(db, userId, ids, now);
}

/** Deletes the local files of released pictures (idempotent) and asks the replica worker to remove remote copies. */
function purgeFiles(released) {
  if (!released.length) return;
  const rt = runtime.get();
  if (!rt.configured) return; // no key/folder to act on; the sweep tidies up once media is configured again
  for (const { id } of released) {
    try { rt.store.remove(id); } catch (err) { logger.warn('Could not delete a photo file', { error: err.code || err.name }); }
  }
  if (rt.s3) replica.nudge();
}

function detach(userId, attachmentId) {
  requireConfigured();
  const db = getDb();
  const released = db.transaction(() => {
    const row = db.prepare(`SELECT a.id, a.media_id FROM active_attachments a WHERE a.id = ? AND a.user_id = ? AND ${liveOwner('a')}`).get(attachmentId, userId);
    if (!row) throw AppError.notFound('Photo not found', 'MEDIA_NOT_FOUND');
    const now = nowIso();
    db.prepare('UPDATE attachments SET deleted_at = ? WHERE id = ? AND user_id = ?').run(now, row.id, userId);
    return releaseMedia(db, userId, [row.media_id], now);
  })();
  purgeFiles(released);
}

/** Account deletion: what must be erased from disk and S3 once the database rows are gone. */
function collectUserMedia(db, userId) {
  return db.prepare('SELECT id, replica_state FROM media WHERE user_id = ?').all(userId).map((r) => ({ id: r.id, remote: r.replica_state !== 'none' }));
}

function eraseFiles(items) {
  const rt = runtime.get();
  if (!rt.configured || !items.length) return;
  for (const { id } of items) {
    try { rt.store.remove(id); } catch (err) { logger.warn('Could not delete a photo file', { error: err.code || err.name }); }
  }
  // The rows (and so any retry) are gone with the account, so this is one best-effort pass in the background.
  if (rt.s3) replica.removeRemote(items.filter((i) => i.remote).map((i) => i.id));
}

/**
 * Orphan sweep. Removes (1) pictures nothing is attached to any more, (2) leftover temp files from interrupted
 * uploads and (3) files of pictures this database has deleted, all only once they are a day old, so an upload in
 * progress is never touched.
 *
 * A file this database has NO row for at all is never deleted. That happens when the database was restored from
 * an older backup (photos added since then have no row) or a different database points at the same folder (a
 * local test setup): in both cases the files are someone's real photos, so they are left alone and reported.
 */
function purgeUnreferenced({ now = Date.now(), maxAgeMs = ORPHAN_AGE_MS } = {}) {
  const rt = runtime.get();
  if (!rt.configured) return null;
  const db = getDb();
  const cutoff = now - maxAgeMs;
  const result = { media: 0, files: 0 };

  const stale = db.prepare(`SELECT id, user_id FROM active_media m WHERE created_at < ? AND NOT EXISTS (
    SELECT 1 FROM active_attachments a WHERE a.media_id = m.id)`).all(new Date(cutoff).toISOString());
  const released = db.transaction(() => stale.flatMap((m) => releaseMedia(db, m.user_id, [m.id])))();
  purgeFiles(released);
  result.media = released.length;

  const known = db.prepare('SELECT deleted_at FROM media WHERE id = ?');
  let unknown = 0;
  for (const file of rt.store.list()) {
    if (file.mtimeMs >= cutoff) continue;
    if (file.temp) { rt.store.removeFile(file.file); result.files += 1; continue; } // an interrupted upload
    const row = known.get(file.id);
    if (!row) { unknown += 1; continue; } // not ours to judge: see above
    if (!row.deleted_at) continue; // a live picture
    rt.store.removeFile(file.file); // a picture this database deleted, whose file removal didn't happen
    result.files += 1;
  }
  if (result.media || result.files) logger.info('Photo sweep removed unused items', result);
  if (unknown) {
    logger.warn('Photo files with no record in this database were left untouched. If you restored a database backup, these are probably photos added after it was taken.', { files: unknown });
  }
  result.unknown = unknown;
  return result;
}

module.exports = {
  requireConfigured, status, listAttachments, upload, openFile, detach, detachOwnerTypes, detachOwner, moveAttachments, purgeFiles,
  collectUserMedia, eraseFiles, purgeUnreferenced, releaseMedia,
};
