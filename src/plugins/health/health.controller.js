const { dbStatus } = require('../../config/db');
const { redisStatus } = require('../../config/redis');
const { sendSuccess } = require('../../core/response');

function getHealth(req, res) {
  sendSuccess(res, {
    status: 'ok',
    db: dbStatus(),
    sessions: redisStatus(),
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  });
}

module.exports = { getHealth };
