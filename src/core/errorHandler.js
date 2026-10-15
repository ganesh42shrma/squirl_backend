const mongoose = require('mongoose');
const multer = require('multer');
const AppError = require('./AppError');
const logger = require('./logger');
const config = require('../config');

// Turns any thrown error into an AppError so the response shape is always the same.
function normalize(err) {
  if (err instanceof AppError) return err;

  if (err instanceof mongoose.Error.ValidationError) {
    const details = Object.values(err.errors).map((e) => ({ path: e.path, message: e.message }));
    return AppError.badRequest('Validation failed', 'VALIDATION_ERROR', details);
  }
  if (err instanceof mongoose.Error.CastError) {
    return AppError.badRequest(`Invalid value for ${err.path}: ${err.value}`, 'INVALID_ID');
  }
  if (err.code === 11000) {
    const fields = Object.keys(err.keyValue || {}).join(', ');
    return AppError.conflict(`A record with this ${fields || 'value'} already exists`, 'DUPLICATE_KEY', err.keyValue);
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
