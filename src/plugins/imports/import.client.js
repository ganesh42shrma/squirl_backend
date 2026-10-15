const config = require('../../config');
const AppError = require('../../core/AppError');
const logger = require('../../core/logger');
const { parserResponse } = require('./import.validation');

/**
 * Sends a statement PDF to the Python parser service and returns its parsed rows.
 * Contract: POST {PARSER_SERVICE_URL}/parse (multipart: file, bank, password?)
 */
async function parseStatement({ buffer, fileName, bank, password }) {
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: 'application/pdf' }), fileName);
  form.append('bank', bank);
  if (password) form.append('password', password);

  let response;
  try {
    response = await fetch(`${config.parser.url}/parse`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(config.parser.timeoutMs),
    });
  } catch (err) {
    logger.error('Parser service request failed', { error: err.message, url: config.parser.url });
    const reason = err.name === 'TimeoutError' ? 'timed out' : 'is unreachable';
    throw AppError.serviceUnavailable(`Statement parser service ${reason}`, 'PARSER_UNAVAILABLE');
  }

  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    // The parser rejected the file itself (wrong password, unsupported layout, …).
    throw new AppError(body.error || 'Statement could not be parsed', 422, 'STATEMENT_PARSE_FAILED');
  }

  const parsed = parserResponse.safeParse(body);
  if (!parsed.success) {
    logger.error('Parser service returned an unexpected response', { issues: parsed.error.issues });
    throw new AppError('Statement parser returned an invalid response', 502, 'PARSER_BAD_RESPONSE');
  }

  return parsed.data;
}

module.exports = { parseStatement };
