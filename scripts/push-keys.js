// Run on the serving desktop once. Keys go straight into the ignored .env, never into stdout.
const { readFileSync, writeFileSync, existsSync, chmodSync } = require('node:fs');
const path = require('node:path');
const webpush = require('web-push');
const file = path.resolve(__dirname, '../.env');
const subject = process.argv[2];
if (!subject || !/^(mailto:[^\s@]+@[^\s@]+\.[^\s@]+|https:\/\/[^\s]+)$/.test(subject)) {
  console.error('Usage: npm run push:keys -- mailto:your-email@example.com');
  process.exit(1);
}
const env = existsSync(file) ? readFileSync(file, 'utf8') : '';
const parsed = require('dotenv').parse(env);
if (parsed.PUSH_PUBLIC_KEY || parsed.PUSH_PRIVATE_KEY) {
  console.error('Push keys already exist. Keep them: changing keys invalidates existing device subscriptions.');
  process.exit(1);
}
const { publicKey, privateKey } = webpush.generateVAPIDKeys();
const cleaned = env.replace(/^[ \t]*(?:export[ \t]+)?PUSH_(PUBLIC_KEY|PRIVATE_KEY|SUBJECT)[ \t]*=.*$/gm, '');
if (existsSync(file)) chmodSync(file, 0o600);
writeFileSync(file, `${cleaned.trimEnd()}\n\nPUSH_PUBLIC_KEY=${publicKey}\nPUSH_PRIVATE_KEY=${privateKey}\nPUSH_SUBJECT=${subject}\n`, { mode: 0o600 });
console.log('Push keys saved to the backend .env. Restart the backend, then enable notifications in Profile on each device.');
