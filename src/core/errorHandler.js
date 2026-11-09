const multer = require('multer');
const AppError = require('./AppError');
const logger = require('./logger');
const config = require('../config');

// SQLite failures that mean "the database file can't be used right now" (drive pulled, wrong key, …).
const DB_UNAVAILABLE = /^SQLITE_(IOERR|CANTOPEN|READONLY|NOTADB|CORRUPT|FULL)/;

function normalizeSqlite(err) {
  const code = String(err.code);
  if (code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
    // "UNIQUE constraint failed: tags.name" → "name"
    const fields = (err.message.split(': ')[1] || '').split(', ').map((f) => f.split('.').pop()).filter(Boolean);
    return AppError.conflict(`A record with this ${fields.join(', ') || 'value'} already exists`, 'DUPLICATE_KEY');
  }
  if (code === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
    return AppError.conflict('This record is referenced by, or refers to, another record', 'REFERENCE_CONFLICT');
  }
  if (code.startsWith('SQLITE_CONSTRAINT')) return AppError.badRequest('Validation failed', 'VALIDATION_ERROR');
  if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED') {
    return AppError.serviceUnavailable('The database is busy, try again', 'DB_BUSY');
  }
  if (DB_UNAVAILABLE.test(code)) {
    return AppError.serviceUnavailable('The database is unavailable. Is the drive plugged in?', 'DB_UNAVAILABLE');
  }
  return null;
}

// Turns any thrown error into an AppError so the response shape is always the same.
function normalize(err) {
  if (err instanceof AppError) return err;

  if (err.name === 'SqliteError') {
    const mapped = normalizeSqlite(err);
    if (mapped) return mapped;
  }
  if (err instanceof multer.MulterError) {
    return AppError.badRequest(err.message, 'UPLOAD_ERROR');
  }
  if (err.type === 'entity.parse.failed') {
    return AppError.badRequest('Malformed JSON body', 'INVALID_JSON');
  }

  return new AppError('Something went wrong', 500, 'INTERNAL_ERROR');
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  const appError = normalize(err);
  const logMeta = { requestId: req.id, method: req.method, url: req.originalUrl, code: appError.code };

  if (appError.statusCode >= 500) {
    logger.error(err.message, { ...logMeta, stack: err.stack });
  } else {
    logger.warn(appError.message, logMeta);
  }

  res.status(appError.statusCode).json({
    success: false,
    error: {
      message: appError.message,
      code: appError.code,
      ...(appError.details && { details: appError.details }),
      requestId: req.id,
      // Stacks only for unexpected crashes, never for errors that were mapped to a 4xx.
      ...(config.isDev && appError.statusCode >= 500 && !(err instanceof AppError) && { stack: err.stack }),
    },
  });
}

module.exports = errorHandler;
