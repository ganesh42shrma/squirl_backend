const service = require('./rules.service');
const { sendSuccess } = require('../../core/response');

async function list(req, res) {
  sendSuccess(res, await service.listRules(req.user.id));
}

async function apply(req, res) {
  const result = await service.applyRules(req.user.id);
  sendSuccess(res, result, { message: `Sorted ${result.applied} row(s) from merchants you've categorised before` });
}

async function remove(req, res) {
  sendSuccess(res, await service.deleteRule(req.user.id, req.params.id), { message: 'Rule deleted' });
}

module.exports = { list, apply, remove };
