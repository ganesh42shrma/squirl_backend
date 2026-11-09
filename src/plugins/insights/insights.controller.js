const service = require('./insights.service');
const suggestions = require('./suggestions.service');
const worker = require('./suggestions.worker');
const { sendSuccess } = require('../../core/response');

async function balances(req, res) {
  sendSuccess(res, await service.getBalances(req.user.id, req.query));
}

async function history(req, res) {
  sendSuccess(res, await service.getHistory(req.user.id, req.query));
}

async function summary(req, res) {
  sendSuccess(res, await service.writeSummary(req.user.id, req.body));
}

async function llmStatus(req, res) {
  sendSuccess(res, await service.getLlmStatus());
}

// Category suggestions: worked out in the background (see suggestions.worker), applied on request.
async function listSuggestions(req, res) {
  sendSuccess(res, await suggestions.listSuggestions(req.user.id, req.query, worker.progressFor(req.user.id)));
}

async function applySuggestions(req, res) {
  const result = await suggestions.applySuggestions(req.user.id, req.body.items);
  sendSuccess(res, result, { message: `Sorted ${result.applied} row(s)` });
}

async function dismissSuggestion(req, res) {
  sendSuccess(res, await suggestions.dismissSuggestion(req.user.id, req.params.id));
}

// "Check now": wake the background job instead of waiting for its next round.
function runSuggestions(req, res) {
  worker.nudge();
  sendSuccess(res, { started: true });
}

module.exports = { balances, history, summary, llmStatus, listSuggestions, applySuggestions, dismissSuggestion, runSuggestions };
