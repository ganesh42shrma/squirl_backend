const mongoose = require('mongoose');
const { sendSuccess } = require('../../core/response');

const DB_STATES = ['disconnected', 'connected', 'connecting', 'disconnecting'];

function getHealth(req, res) {
  sendSuccess(res, {
    status: 'ok',
    db: DB_STATES[mongoose.connection.readyState] || 'unknown',
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  });
}

module.exports = { getHealth };
