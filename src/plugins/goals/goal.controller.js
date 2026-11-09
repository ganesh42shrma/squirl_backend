const service = require('./goal.service');
const analysis = require('./goal.analysis');
const worker = require('./goal.worker');
const { sendSuccess } = require('../../core/response');

const list = async (req, res) => sendSuccess(res, await service.listGoals(req.user.id));
const options = async (req, res) => sendSuccess(res, await service.getOptions(req.user.id));
const plan = async (req, res) => sendSuccess(res, await service.previewPlan(req.user.id, req.body));
const assist = async (req, res) => sendSuccess(res, await analysis.assistSetup(req.user.id, req.body));
const getOne = async (req, res) => sendSuccess(res, await service.getGoal(req.user.id, req.params.id));
const create = async (req, res) => sendSuccess(res, await service.createGoal(req.user.id, req.body), { status: 201, message: 'Goal added' });
const update = async (req, res) => sendSuccess(res, await service.updateGoal(req.user.id, req.params.id, req.body), { message: 'Saved' });
const remove = async (req, res) => sendSuccess(res, await service.deleteGoal(req.user.id, req.params.id), { message: 'Deleted' });

const addContribution = async (req, res) => sendSuccess(res, await service.addContribution(req.user.id, req.params.id, req.body), { status: 201, message: 'Added' });
const removeContribution = async (req, res) => sendSuccess(res, await service.removeContribution(req.user.id, req.params.id, req.params.contributionId), { message: 'Removed' });
const exclude = async (req, res) => sendSuccess(res, await service.excludeTransaction(req.user.id, req.params.id, req.body.transactionId), { message: 'Left out' });
const candidates = async (req, res) => sendSuccess(res, await service.linkCandidates(req.user.id, req.params.id, req.query.search));

// The written plan check: the saved one (with "stale" when figures moved), or a fresh one on request.
const getAnalysis = async (req, res) =>
  sendSuccess(res, { ...(await analysis.getAnalysis(req.user.id, req.params.id)), pending: worker.isPending(req.user.id) });
const refreshAnalysis = async (req, res) =>
  sendSuccess(res, { analysis: await analysis.generateAnalysis(req.user.id, req.params.id, { force: true }), stale: false, pending: false });

module.exports = { list, options, plan, assist, getOne, create, update, remove, addContribution, removeContribution, exclude, candidates, getAnalysis, refreshAnalysis };
