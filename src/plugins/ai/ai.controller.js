const service = require('./ai.service');
const { sendSuccess } = require('../../core/response');

const getSettings = async (req, res) => sendSuccess(res, await service.getPublicSettings(req.user.id));
const updateSettings = async (req, res) => sendSuccess(res, await service.updateSettings(req.user.id, req.body), { message: 'Saved' });
const models = async (req, res) => sendSuccess(res, await service.listModels(req.user.id, req.query.provider));
const test = async (req, res) => sendSuccess(res, await service.testProvider(req.user.id, req.body.provider));

module.exports = { getSettings, updateSettings, models, test };
