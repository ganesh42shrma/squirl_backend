const service = require('./import.service');
const AppError = require('../../core/AppError');
const { sendSuccess } = require('../../core/response');

async function create(req, res) {
  if (!req.file) throw AppError.badRequest('A PDF statement is required in the "file" field', 'FILE_REQUIRED');

  const batch = await service.createImport({ file: req.file, bank: req.body.bank, password: req.body.password });
  sendSuccess(res, batch, { status: 201, message: `Imported ${batch.stats.inserted} transaction(s)` });
}

async function list(req, res) {
  const { items, meta } = await service.listImports(req.query);
  sendSuccess(res, items, { meta });
}

async function getOne(req, res) {
  sendSuccess(res, await service.getImport(req.params.id));
}

async function remove(req, res) {
  const result = await service.deleteImport(req.params.id);
  sendSuccess(res, result, { message: 'Import and its transactions deleted' });
}

module.exports = { create, list, getOne, remove };
