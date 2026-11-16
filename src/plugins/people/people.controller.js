const service = require('./people.service');
const AppError = require('../../core/AppError');
const { sendSuccess } = require('../../core/response');

async function list(req, res) {
  const { items, meta } = await service.listPeople(req.user.id, req.query);
  sendSuccess(res, items, { meta });
}
async function getOne(req, res) { sendSuccess(res, await service.getPerson(req.user.id, req.params.id)); }
async function create(req, res) { sendSuccess(res, await service.createPerson(req.user.id, req.body), { status: 201, message: 'Person added' }); }
async function update(req, res) { sendSuccess(res, await service.updatePerson(req.user.id, req.params.id, req.body), { message: 'Person saved' }); }
async function remove(req, res) {
  await service.removePerson(req.user.id, req.params.id);
  sendSuccess(res, null, { message: 'Person removed' });
}
async function importContacts(req, res) {
  if (!req.file) throw AppError.badRequest('Choose a contacts file (.vcf) to import', 'FILE_REQUIRED');
  sendSuccess(res, await service.importContacts(req.user.id, req.file.buffer), { message: 'Contacts imported' });
}

module.exports = { list, getOne, create, update, remove, importContacts };
