const config = require('./config');
const logger = require('./core/logger');
const { connectDB, disconnectDB } = require('./config/db');
const app = require('./app');

let server;

async function start() {
  await connectDB();
  server = app.listen(config.port, () => {
    logger.info(`Server running on http://localhost:${config.port} (${config.env})`);
  });
}

async function shutdown(signal, exitCode = 0) {
  logger.info(`${signal} received, shutting down`);
  const forceExit = setTimeout(() => process.exit(1), 10000).unref();

  if (server) await new Promise((resolve) => server.close(resolve));
  await disconnectDB().catch(() => {});

  clearTimeout(forceExit);
  process.exit(exitCode);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection', { error: reason instanceof Error ? reason.stack : reason });
  shutdown('unhandledRejection', 1);
});
process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception', { error: err.stack });
  shutdown('uncaughtException', 1);
});

start().catch((err) => {
  logger.error('Failed to start server', { error: err.stack });
  process.exit(1);
});
