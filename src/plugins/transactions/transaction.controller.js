const service = require('./transaction.service');
const { sendSuccess } = require('../../core/response');

async function list(req, res) {
  const { items, meta } = await service.listTransactions(req.user.id, req.query);
  sendSuccess(res, items, { meta });
}

async function summary(req, res) {
  sendSuccess(res, await service.getSummary(req.user.id, req.query));
}

async function getOne(req, res) {
  sendSuccess(res, await service.getTransaction(req.user.id, req.params.id));
}

async function create(req, res) {
  sendSuccess(res, await service.createTransaction(req.user.id, req.body), { status: 201, message: 'Transaction created' });
}

async function bulkCreate(req, res) {
  const result = await service.bulkCreateTransactions(req.user.id, req.body.transactions);
  sendSuccess(res, result, { status: 201, message: `${result.inserted} transaction(s) created` });
}

async function update(req, res) {
  sendSuccess(res, await service.updateTransaction(req.user.id, req.params.id, req.body), { message: 'Transaction updated' });
}

async function bulkUpdate(req, res) {
  const result = await service.bulkUpdateTransactions(req.user.id, req.body.ids, req.body.set);
  sendSuccess(res, result, { message: `${result.modified} transaction(s) updated` });
}

async function remove(req, res) {
  await service.deleteTransaction(req.user.id, req.params.id);
  sendSuccess(res, null, { message: 'Transaction deleted' });
}

module.exports = { list, summary, getOne, create, bulkCreate, update, bulkUpdate, remove };
