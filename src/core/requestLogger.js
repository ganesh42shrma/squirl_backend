const { randomUUID } = require('crypto');
const logger = require('./logger');

function requestLogger(req, res, next) {
  const start = process.hrtime.bigint();
  req.id = req.get('X-Request-Id') || randomUUID();
  res.set('X-Request-Id', req.id);

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
    logger.log(level, `${req.method} ${req.originalUrl} ${res.statusCode} ${durationMs.toFixed(1)}ms`, {
      requestId: req.id,
    });
  });

  next();
}

module.exports = requestLogger;
