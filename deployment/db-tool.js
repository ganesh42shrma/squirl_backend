// Read schema versions without migrations, or migrate ONLY an explicitly supplied encrypted copy.
const path = require('node:path');
const { createRequire } = require('node:module');

async function main() {
  const backend = path.resolve(process.argv[2]);
  if (!process.env.DB_PATH || !process.env.DB_KEY) throw new Error('Database path/key must be supplied privately through the environment.');
  let version;
  if (process.argv.includes('--migrate')) {
    const api = require(path.join(backend, 'src/config/db'));
    try { await api.connectDB(); version = api.getDb().pragma('user_version', { simple: true }); }
    finally { await api.disconnectDB(); }
  } else {
    const Database = createRequire(path.join(backend, 'package.json'))('better-sqlite3-multiple-ciphers');
    const db = new Database(process.env.DB_PATH, { readonly: true, fileMustExist: true });
    try {
      db.pragma("cipher = 'sqlcipher'"); db.pragma('legacy = 4');
      db.pragma(`key = '${process.env.DB_KEY.replace(/'/g, "''")}'`);
      version = db.pragma('user_version', { simple: true });
      if (db.pragma('journal_mode', { simple: true }) !== 'delete') throw new Error('Unsupported journal mode');
    } finally { db.close(); }
  }
  console.log(JSON.stringify({ version }));
}
main().catch(() => { console.error('Encrypted database schema check failed; check the database/key and deployment logs.'); process.exitCode = 1; });
