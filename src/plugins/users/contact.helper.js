// Match Indian mobile numbers only as complete UPI identifiers, never as a substring of a ref.
function normalizePhone(value) {
  const text = String(value || '').trim();
  if (!text || !/^\+?[\d\s()-]+$/.test(text)) return null;
  let digits = text.replace(/\D/g, '');
  if (digits.length === 14 && digits.startsWith('0091')) digits = digits.slice(4);
  else if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
  else if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  return /^[6-9]\d{9}$/.test(digits) ? digits : null;
}

// The UPI id(s) a bank row names: SBI's "UPI/DR/ref/name/bank/handle/remark" and Kotak's "UPI/handle/...".
function upiHandles(description) {
  const raw = String(description || '').replace(/^(WDL|DEP)\s+TFR\s+/i, '').trim();
  const parts = raw.split('/').map((p) => p.trim());
  if (parts[0]?.toUpperCase() !== 'UPI') return [];
  const candidates = [];
  if (/^(DR|CR)$/i.test(parts[1]) && /^\d{6,}$/.test((parts[2] || '').replace(/\s/g, ''))) {
    // SBI: UPI/DR|CR/ref/name/bank/UPI-id/remark. Some statements omit @bank.
    if (/^[A-Z]{4}$/i.test((parts[4] || '').replace(/\s/g, ''))) candidates.push(parts[5]);
    if (parts[3]?.includes('@')) candidates.push(parts[3]);
  } else if (parts[1]?.includes('@')) {
    // Kotak sometimes puts the VPA itself in the counterparty field.
    candidates.push(parts[1]);
  }
  return candidates;
}

function upiPhones(description) {
  return upiHandles(description).map((value) => normalizePhone(String(value || '').split('@')[0])).filter(Boolean);
}

function memberCandidate(description) {
  const { counterparty } = require('../rules/rules.helper');
  const party = counterparty(description);
  return {
    name: /^(UPI|NEFT|IMPS) /.test(party.key) && !/^\d/.test(party.name) ? party.name : '',
    phone: upiPhones(description)[0] || '',
  };
}

// What "Who is this?" can remember about a payment: its UPI id, else the payee name. Both are normalised so the
// same person written slightly differently by the bank still matches. Empty strings mean "nothing to link".
const VPA = /^[a-z0-9._-]{2,64}(@[a-z0-9.-]{2,40})?$/;
function linkKeys(description) {
  const { normalizeName } = require('./family');
  const vpa = upiHandles(description).map((v) => String(v || '').replace(/\s/g, '').toLowerCase()).find((v) => VPA.test(v)) || '';
  const payee = normalizeName(memberCandidate(description).name);
  return { vpa, payee: payee.length >= 3 ? payee : '' };
}

module.exports = { normalizePhone, upiPhones, upiHandles, memberCandidate, linkKeys };
