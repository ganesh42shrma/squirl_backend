const mongoose = require('mongoose');
const config = require('./index');
const logger = require('../core/logger');

mongoose.connection.on('disconnected', () => logger.info('MongoDB disconnected'));
mongoose.connection.on('reconnected', () => logger.info('MongoDB reconnected'));
mongoose.connection.on('error', (err) => logger.error('MongoDB error', { error: err.message }));

async function connectDB() {
  await mongoose.connect(config.mongoUri);
  logger.info(`MongoDB connected: ${mongoose.connection.host}/${mongoose.connection.name}`);
}

async function disconnectDB() {
  await mongoose.disconnect();
  logger.info('MongoDB connection closed');
}

module.exports = { connectDB, disconnectDB };
