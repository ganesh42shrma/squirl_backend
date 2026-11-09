// Creates the SQLCipher key once and stores it in the macOS Keychain (never on the drive).
//   npm run db:key            create the key if there isn't one
//   npm run db:key -- --show  print it, so you can save a backup copy in your password manager
const fs = require('fs');
const { randomBytes } = require('crypto');
const { execFileSync } = require('child_process');
const config = require('../config');
const { KEYCHAIN, readKeychainKey } = require('../config/dbKey');

function main() {
  if (process.platform !== 'darwin') {
    console.error('The Keychain is macOS only. Set DB_KEY in the environment instead.');
    return 1;
  }

  const existing = readKeychainKey();
  if (process.argv.includes('--show')) {
    if (!existing) {
      console.error('No key in the Keychain yet. Run "npm run db:key" first.');
      return 1;
    }
    console.log(existing);
    return 0;
  }

  if (existing) {
    console.log(`A key already exists in the Keychain (service "${KEYCHAIN.service}"). Nothing to do.`);
    return 0;
  }
  if (fs.existsSync(config.db.path)) {
    // A new key could never open the existing file. Restore the old key instead.
    console.error(`${config.db.path} already exists but no key was found. Restore its key (Keychain or DB_KEY); a new key would not open it.`);
    return 1;
  }

  const key = randomBytes(32).toString('hex');
  execFileSync('security', ['add-generic-password', '-s', KEYCHAIN.service, '-a', KEYCHAIN.account, '-l', 'Squirl database key', '-w', key]);
  console.log(`Key created in the macOS Keychain (service "${KEYCHAIN.service}").`);
  console.log('Back it up now: run "npm run db:key -- --show" and store it in your password manager.');
  console.log('Without it the database on the drive cannot be decrypted.');
  return 0;
}

process.exit(main());
