// Where the SQLCipher key comes from: DB_KEY if set, otherwise the macOS Keychain.
// The key must never live on the drive that holds the database.
const { execFileSync } = require('child_process');
const config = require('./index');

const KEYCHAIN = Object.freeze({ service: 'squirl-db', account: 'squirl' });

function readKeychainKey() {
  if (process.platform !== 'darwin') return null;
  try {
    const out = execFileSync('security', ['find-generic-password', '-s', KEYCHAIN.service, '-a', KEYCHAIN.account, '-w'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.trim() || null;
  } catch {
    return null; // not found
  }
}

function getDbKey() {
  const key = config.db.key || readKeychainKey();
  if (!key) {
    const setup = process.platform === 'darwin'
      ? 'For a new database, run "npm run db:key" to create a key in your macOS Keychain. For an existing database, restore its original key in the Keychain or set DB_KEY.'
      : 'Set DB_KEY in the backend .env or environment. For an existing USB database, use its original key from your Mac or password-manager backup; a new key cannot unlock it. The macOS Keychain and "npm run db:key" are not available on this system.';
    throw new Error(`No database key found. ${setup}`);
  }
  return key;
}

module.exports = { KEYCHAIN, readKeychainKey, getDbKey };
