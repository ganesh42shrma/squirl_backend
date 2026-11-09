// Delivers account emails. There's no mail server configured yet, so in development the
// message is printed to this terminal (never to the log files, since a reset link is a credential).
// To send real email, implement `send` with an SMTP client and keep the same signature.
const config = require('../config');
const logger = require('./logger');

async function send({ to, subject, text }) {
  if (config.isDev) {
    const line = '─'.repeat(60);
    // eslint-disable-next-line no-console
    console.log(`\n${line}\nEmail to ${to}: ${subject}\n\n${text}\n${line}\n`);
    return true;
  }
  logger.warn('Email not sent: no mail delivery is configured', { subject });
  return false;
}

module.exports = { send };
