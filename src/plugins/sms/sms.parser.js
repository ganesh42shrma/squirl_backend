// Deliberately narrow bank templates. Unrecognized financial messages require human review.
const MONEY = '(?<amount>[\\d,]+\\.\\d{2})';
const REF = '(?<ref>\\d{12})';
const templates = [
  { bank: 'sbi', type: 'debit', pattern: new RegExp(`^Dear UPI user A/C X(?<last4>\\d{4}) debited by ${MONEY} on date (?<day>\\d{2})(?<month>[A-Za-z]{3})(?<year>\\d{2}) trf to (?<party>.{1,140}?) Refno ${REF}\\.?(?: If not u\\? call-[\\d-]+ for other services-[\\d-]+-SBI)?$`, 'i') },
  { bank: 'kotak', type: 'debit', pattern: new RegExp(`^Sent Rs\\.?\\s*${MONEY} from Kotak Bank A/c X(?<last4>\\d{4}) to (?<party>.{1,140}?) on (?<day>\\d{2})-(?<month>\\d{2})-(?<year>\\d{2})\\.\\s*UPI Ref\\s*:?\\s*${REF}\\.?(?: Not done by you\\? Tap https:\\/\\/[^\\s]+)?$`, 'i') },
  { bank: 'kotak', type: 'credit', pattern: new RegExp(`^Received Rs\\.?\\s*${MONEY} in your Kotak Bank A/?C X?(?<last4>\\d{4}) from (?<party>.{1,140}?) on (?<day>\\d{2})-(?<month>\\d{2})-(?<year>\\d{2})\\.\\s*UPI Ref\\s*:?\\s*${REF}\\.?$`, 'i') },
];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const normalize = (body) => body.replace(/\s+/g, ' ').trim();

function parseSms(body) {
  const text = normalize(body);
  if (/\b(?:otp|one[ -]time (?:password|code)|verification code|upi pin)\b/i.test(text)) return { status: 'ignored', reason: 'otp_or_secret' };
  for (const { bank, type, pattern } of templates) {
    const m = pattern.exec(text);
    if (!m) continue;
    const g = m.groups;
    if (!/^(?:\d+|\d{1,3}(?:,\d{3})+|\d{1,2}(?:,\d{2})*,\d{3})\.\d{2}$/.test(g.amount)) return { status: 'review', reason: 'invalid_amount' };
    const paise = Number(g.amount.replace(/,/g, '').replace('.', ''));
    if (!Number.isSafeInteger(paise) || paise <= 0) return { status: 'review', reason: 'invalid_amount' };
    const month = /^\d+$/.test(g.month) ? Number(g.month) : MONTHS.indexOf(g.month.toLowerCase()) + 1;
    const year = 2000 + Number(g.year), day = Number(g.day);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return { status: 'review', reason: 'invalid_date' };
    return { status: 'parsed', bank, last4: g.last4, date: date.toISOString().slice(0, 10), amount: paise / 100, type,
      refNo: g.ref, paymentMode: 'upi', description: `UPI/${type === 'debit' ? 'DR' : 'CR'}/${g.ref}/${g.party.trim()}` };
  }
  if (/\b(?:transaction|payment|transfer)\b.*\b(?:failed|declined|pending|unsuccessful)\b|\b(?:request to pay|collect request|payment request)\b/i.test(text)) return { status: 'ignored', reason: 'not_completed' };
  return { status: 'review', reason: 'unsupported_format' };
}

module.exports = { parseSms, normalize };
