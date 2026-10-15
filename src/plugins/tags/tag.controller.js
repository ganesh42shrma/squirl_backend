const service = require('./tag.service');
const { sendSuccess } = require('../../core/response');

async function list(req, res) {
  sendSuccess(res, await service.listTags(req.query));
}

async function create(req, res) {
  sendSuccess(res, await service.createTag(req.body), { status: 201, message: 'Tag created' });
}

async function update(req, res) {
  sendSuccess(res, await service.updateTag(req.params.id, req.body), { message: 'Tag updated' });
}

async function remove(req, res) {
  const result = await service.deleteTag(req.params.id);
  sendSuccess(res, result, { message: `Tag deleted and removed from ${result.removedFromTransactions} transaction(s)` });
}

module.exports = { list, create, update, remove };
