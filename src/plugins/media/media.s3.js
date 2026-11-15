// A tiny S3-compatible client (Cloudflare R2, Backblaze B2, MinIO, AWS...) with AWS Signature V4 written
// against node:crypto and the built-in fetch: no SDK and no extra dependency. It does three things: PUT, GET
// and DELETE one object. What it stores is already encrypted by the app, so the bucket only holds opaque blobs.
const { createHash, createHmac } = require('node:crypto');

const TIMEOUT_MS = 15_000;
const sha256Hex = (data) => createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => createHmac('sha256', key).update(data).digest();

// S3 wants every byte outside A-Z a-z 0-9 - _ . ~ percent-encoded, in each path segment ("/" stays).
const encodeSegment = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

const isLoopback = (host) => host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';

class S3Error extends Error {
  constructor(message, status) { super(message); this.name = 'S3Error'; this.status = status; }
}

/**
 * Builds the signed request for one call. Exported so tests can check the signature against a known vector.
 * `date` is injectable for the same reason.
 */
function signRequest({ method, endpoint, bucket, key, region, accessKeyId, secretAccessKey, pathStyle = true, body = Buffer.alloc(0), date = new Date() }) {
  const base = new URL(endpoint);
  const objectPath = key.split('/').map(encodeSegment).join('/');
  const host = pathStyle ? base.host : `${bucket}.${base.host}`;
  const prefix = base.pathname.replace(/\/+$/, '');
  const canonicalPath = pathStyle ? `${prefix}/${encodeSegment(bucket)}/${objectPath}` : `${prefix}/${objectPath}`;
  const stamp = date.toISOString().replace(/[:-]|\.\d{3}/g, ''); // 20260101T000000Z
  const day = stamp.slice(0, 8);
  // The real SHA-256 of the body is signed (never UNSIGNED-PAYLOAD), so a body changed in transit is refused.
  const payloadHash = sha256Hex(body);
  const headers = { host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': stamp };
  const signedHeaders = Object.keys(headers).sort().join(';');
  const canonicalHeaders = Object.keys(headers).sort().map((h) => `${h}:${headers[h]}\n`).join('');
  const canonicalRequest = [method, canonicalPath, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${day}/${region}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', stamp, scope, sha256Hex(canonicalRequest)].join('\n');
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, day), region), 's3'), 'aws4_request');
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');
  return {
    url: `${base.protocol}//${host}${canonicalPath}`,
    headers: {
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': stamp,
      Authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
    canonicalRequest,
    stringToSign,
  };
}

function createS3Client(options, { fetchImpl = (...args) => fetch(...args), maxObjectBytes = 64 * 1024 * 1024 } = {}) {
  const { endpoint, bucket, region, accessKeyId, secretAccessKey, pathStyle } = options;

  async function call(method, key, body) {
    const signed = signRequest({ method, endpoint, bucket, key, region, accessKeyId, secretAccessKey, pathStyle, body });
    let response;
    try {
      response = await fetchImpl(signed.url, {
        method,
        headers: signed.headers,
        ...(body && { body }),
        redirect: 'manual', // a redirect would re-send our signed request somewhere we did not choose
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      // Never include err.cause / the URL's query or any header: only a short reason.
      throw new S3Error(`S3 ${method} could not reach the server (${err?.name === 'TimeoutError' ? 'timed out' : 'network error'})`);
    }
    return response;
  }

  // The S3 error body names a short code like "AccessDenied"; the rest of it is not needed.
  async function fail(method, response) {
    let code = '';
    try { code = /<Code>([A-Za-z0-9]{1,64})<\/Code>/.exec(await response.text())?.[1] || ''; } catch { /* ignore */ }
    throw new S3Error(`S3 ${method} failed with status ${response.status}${code ? ` (${code})` : ''}`, response.status);
  }

  return {
    async put(key, bytes) {
      const response = await call('PUT', key, bytes);
      if (!response.ok) await fail('PUT', response);
      await response.arrayBuffer().catch(() => {});
    },
    // Returns the object's bytes, or null if the bucket doesn't have it.
    async get(key) {
      const response = await call('GET', key);
      if (response.status === 404) { await response.arrayBuffer().catch(() => {}); return null; }
      if (!response.ok) await fail('GET', response);
      if (Number(response.headers.get('content-length')) > maxObjectBytes) throw new S3Error('S3 GET returned an unexpectedly large object');
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > maxObjectBytes) throw new S3Error('S3 GET returned an unexpectedly large object');
      return bytes;
    },
    // Deleting something that is already gone counts as success.
    async remove(key) {
      const response = await call('DELETE', key);
      if (!response.ok && response.status !== 404) await fail('DELETE', response);
      await response.arrayBuffer().catch(() => {});
    },
  };
}

module.exports = { createS3Client, signRequest, isLoopback, S3Error, TIMEOUT_MS };
