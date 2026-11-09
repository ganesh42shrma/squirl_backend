const service = require('./commitment.service');
const { sendSuccess } = require('../../core/response');

const list = async (req, res) => sendSuccess(res, await service.listCommitments(req.user.id));
const alerts = async (req, res) => sendSuccess(res, await service.listAlerts(req.user.id));
const detected = async (req, res) => sendSuccess(res, await service.detectRecurring(req.user.id));
const merchants = async (req, res) => sendSuccess(res, await service.searchMerchants(req.user.id, req.query.search));
const getOne = async (req, res) => sendSuccess(res, await service.getCommitment(req.user.id, req.params.id));
const schedule = async (req, res) => sendSuccess(res, await service.getSchedule(req.user.id, req.params.id));
const create = async (req, res) => sendSuccess(res, await service.createCommitment(req.user.id, req.body), { status: 201, message: 'Added' });
const update = async (req, res) => sendSuccess(res, await service.updateCommitment(req.user.id, req.params.id, req.body), { message: 'Saved' });
const remove = async (req, res) => sendSuccess(res, await service.deleteCommitment(req.user.id, req.params.id), { message: 'Deleted' });

module.exports = { list, alerts, detected, merchants, getOne, schedule, create, update, remove };
