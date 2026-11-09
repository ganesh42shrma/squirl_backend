const service = require('./category.service');
const { sendSuccess } = require('../../core/response');

async function list(req, res) {
  sendSuccess(res, await service.listCategories(req.user.id, req.query));
}

async function create(req, res) {
  sendSuccess(res, await service.createCategory(req.user.id, req.body), { status: 201, message: 'Category created' });
}

async function update(req, res) {
  sendSuccess(res, await service.updateCategory(req.user.id, req.params.id, req.body), { message: 'Category updated' });
}

async function remove(req, res) {
  await service.deleteCategory(req.user.id, req.params.id);
  sendSuccess(res, null, { message: 'Category deleted' });
}

module.exports = { list, create, update, remove };
