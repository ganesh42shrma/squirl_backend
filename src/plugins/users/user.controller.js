const service = require('./user.service');
const { sendSuccess } = require('../../core/response');

async function me(req, res) {
  sendSuccess(res, await service.getProfile(req.user.id));
}

async function update(req, res) {
  sendSuccess(res, await service.updateProfile(req.user.id, req.body), { message: 'Profile updated' });
}

async function changePassword(req, res) {
  const changedAt = await service.changePassword(req.user.id, req.body);
  // Keep this session valid; every other session (other devices) is now signed out.
  req.session.passwordChangedAt = changedAt;
  sendSuccess(res, null, { message: 'Password changed. Other sessions have been signed out' });
}

async function remove(req, res) {
  await service.deleteAccount(req.user.id, req.body);
  req.session.destroy(() => {
    res.clearCookie('squirl.sid');
    sendSuccess(res, null, { message: 'Account and all its data deleted' });
  });
}

async function addFamilyMember(req, res) {
  sendSuccess(res, await service.addFamilyMember(req.user.id, req.body), { message: 'Member saved' });
}

async function resetFinancialData(req, res) {
  sendSuccess(res, await service.resetFinancialData(req.user.id), { message: 'Financial data reset' });
}

async function familySync(req, res) {
  sendSuccess(res, require('./family.worker').statusFor(req.user.id));
}

module.exports = { me, update, changePassword, remove, addFamilyMember, resetFinancialData, familySync };
