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
    throw new Error('No database key found. Run "npm run db:key" once to create one in your macOS Keychain, or set DB_KEY.');
  }
  return key;
}

module.exports = { KEYCHAIN, readKeychainKey, getDbKey };
