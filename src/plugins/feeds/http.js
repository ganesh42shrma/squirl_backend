// HTTP for the public data sources. Plain fetch with a timeout, except MoSPI, whose server only
// completes a TLS 1.2 handshake with OpenSSL's legacy-server-connect option. Certificate checks
// stay on for every source.
const https = require('https');
const { constants } = require('crypto');
const AppError = require('../../core/AppError');

const USER_AGENT = 'Squirl/1.0 (personal finance app)';

const unavailable = (source) => AppError.serviceUnavailable(`${source} isn’t answering right now`, 'FEED_UNAVAILABLE');
const keyError = (source) => AppError.badRequest(`${source} rejected the API key. Check it in Profile → Data sources.`, 'FEED_KEY_INVALID');
const rateError = (source) => new AppError(`${source} is rate-limiting requests, or today’s free calls are used up. Try again later.`, 429, 'FEED_RATE_LIMITED');

async function getJson(url, { source, headers = {}, timeoutMs = 10_000 } = {}) {
  let response;
  try {
    response = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', ...headers }, signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    throw unavailable(source);
  }
  if (response.status === 401 || response.status === 403) throw keyError(source);
  if (response.status === 429) throw rateError(source);
  if (!response.ok) throw unavailable(source);
  const body = await response.json().catch(() => null);
  if (body === null) throw unavailable(source);
  return body;
}

const mospiAgent = new https.Agent({ keepAlive: true, maxVersion: 'TLSv1.2', secureOptions: constants.SSL_OP_LEGACY_SERVER_CONNECT });

/** GET a JSON path on api.mospi.gov.in. Swappable in tests. */
function mospiGet(path, { timeoutMs = 25_000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(`https://api.mospi.gov.in${path}`, { agent: mospiAgent, headers: { 'User-Agent': USER_AGENT }, timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        try {
          if (res.statusCode !== 200) throw new Error(`HTTP ${res.statusCode}`);
          resolve(JSON.parse(body));
        } catch {
          reject(unavailable('MoSPI'));
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => reject(unavailable('MoSPI')));
  });
}

// mospiGet goes through mospiGetImpl so tests can swap the transport.
module.exports = { getJson, unavailable, keyError, rateError, mospiGet: (...args) => module.exports.mospiGetImpl(...args), mospiGetImpl: mospiGet, USER_AGENT };
