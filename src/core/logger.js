const path = require('path');
const winston = require('winston');
const config = require('../config');

const { combine, timestamp, errors, json, colorize, printf } = winston.format;
const logDir = path.join(__dirname, '../../logs');

const devFormat = printf(({ timestamp, level, message, stack, ...meta }) => {
  const extra = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
  return `${timestamp} ${level}: ${message}${extra}${stack ? `\n${stack}` : ''}`;
});

const logger = winston.createLogger({
  level: config.logLevel,
  format: combine(timestamp(), errors({ stack: true }), json()),
  transports: [
    new winston.transports.Console({
      format: config.isDev
        ? combine(colorize(), timestamp({ format: 'HH:mm:ss' }), errors({ stack: true }), devFormat)
        : undefined,
    }),
    new winston.transports.File({ filename: path.join(logDir, 'error.log'), level: 'error' }),
    new winston.transports.File({ filename: path.join(logDir, 'app.log') }),
  ],
});

module.exports = logger;
