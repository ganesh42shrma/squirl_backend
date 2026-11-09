// SQLite connection, encrypted with SQLCipher. One synchronous connection for the whole process.
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3-multiple-ciphers');
const config = require('./index');
const logger = require('../core/logger');
const AppError = require('../core/AppError');
const { getDbKey } = require('./dbKey');
const MIGRATIONS = require('./migrations');

let db = null;

// Creates the database folder, but only its last segment: if the drive isn't mounted,
// /Volumes/<drive> is missing and we fail instead of silently writing to the internal disk.
function ensureFolder(file) {
  const dir = path.dirname(file);
  if (fs.existsSync(dir)) return;
  if (!fs.existsSync(path.dirname(dir))) {
    throw new Error(`Database location ${path.dirname(dir)} not found. Is the drive plugged in?`);
  }
  fs.mkdirSync(dir);
}

function migrate(conn) {
  const current = conn.pragma('user_version', { simple: true });
  if (current > MIGRATIONS.length) {
    throw new Error(`Database schema v${current} is newer than this code understands (v${MIGRATIONS.length})`);
  }
  if (current === MIGRATIONS.length) return;
  conn.transaction(() => {
    for (let v = current; v < MIGRATIONS.length; v += 1) {
      const migration = MIGRATIONS[v];
      if (typeof migration === 'function') migration(conn);
      else conn.exec(migration);
    }
    conn.pragma(`user_version = ${MIGRATIONS.length}`);
  })();
  logger.info(`Database schema migrated v${current} → v${MIGRATIONS.length}`);
}

async function connectDB() {
  if (db) return;
  const file = config.db.path;
  ensureFolder(file);
  const isNew = !fs.existsSync(file);

  const conn = new Database(file, { timeout: 5000 });
  try {
    conn.pragma("cipher = 'sqlcipher'"); // standard SQLCipher v4 format, readable by the sqlcipher CLI
    conn.pragma('legacy = 4');
    conn.pragma(`key = '${getDbKey().replace(/'/g, "''")}'`);
    conn.prepare('SELECT count(*) FROM sqlite_master').get(); // first real read: fails here on a wrong key

    // Rollback journal + FULL sync: safest on a removable drive. The DB is one self-contained
    // file whenever it is idle (no -wal/-shm side files to lose).
    conn.pragma('journal_mode = DELETE');
    conn.pragma('synchronous = FULL');
    // Migrations run with foreign keys OFF: a table rebuild (CREATE new, copy, DROP old, RENAME)
    // must not cascade. better-sqlite3 turns them ON by default, so this has to be explicit,
    // otherwise DROP TABLE deletes every dependent row through ON DELETE CASCADE.
    // Every reference is then checked before they're switched on for normal use.
    conn.pragma('foreign_keys = OFF');
    migrate(conn);
    const broken = conn.pragma('foreign_key_check');
    if (broken.length) throw new Error(`Database has ${broken.length} broken reference(s) after migration`);
    conn.pragma('foreign_keys = ON');
  } catch (err) {
    conn.close();
    if (err.code === 'SQLITE_NOTADB') {
      throw new Error(`Could not decrypt ${file}: wrong database key, or the file is not a Squirl database`);
    }
    throw err;
  }

  db = conn;
  logger.info(`SQLite (SQLCipher) ${isNew ? 'created' : 'opened'}: ${file}`);
}

async function disconnectDB() {
  if (!db) return;
  db.close();
  db = null;
  logger.info('SQLite connection closed');
}

function getDb() {
  if (!db) throw AppError.serviceUnavailable('Database is not open', 'DB_UNAVAILABLE');
  return db;
}

// 'connected' only if the connection is open and the file is still there (drive not pulled).
function dbStatus() {
  if (!db) return 'disconnected';
  try {
    db.prepare('SELECT 1').get();
    return fs.existsSync(config.db.path) ? 'connected' : 'unavailable';
  } catch {
    return 'unavailable';
  }
}

module.exports = { connectDB, disconnectDB, getDb, dbStatus };
