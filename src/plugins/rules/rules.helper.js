/**
 * Who a bank row is with, as a stable key, so every payment to the same merchant or person groups
 * together however the bank words the remark. Used by merchant memory and model suggestions; stored
 * keys depend on it (a change needs a re-key migration, see config/migrations.js).
 *
 *   SBI   "WDL TFR UPI/DR/616343476554/Google A/utib/playstore1/Sent"  → name "GOOGLE A", handle "PLAYSTORE"
 *   Kotak "UPI/MANJUNATHA B/SBIN/786955526962/Payment from"            → name "MANJUNATHA B"
 *   NEFT  "NEFT*UTIB0000001*AXN12345678*ACME LTD"                       → name "ACME LTD"
 *   other "SMS ALERT CHG FOR THE MONTH OF JUL26"                        → "SMS ALERT CHG FOR THE MONTH OF"
 */

const BANK_CODE = /^[A-Z]{4}$/; // HDFC, SBIN, UTIB, YESB… (after removing wrap spaces: "H DFC" → "HDFC")
const IFSC = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const MONTHS = /\b(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|SEPT|OCT|NOV|DEC)\b/g;

const clean = (text) =>
  String(text || '')
    .toUpperCase()
    .replace(/[^A-Z0-9& ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

// A UPI handle without its varying digits: "paytm-8396" → "PAYTM", "zomato.ete" → "ZOMATO ETE".
const cleanHandle = (handle) => clean(String(handle).split('@')[0].replace(/[\d]+/g, ' '));

// Generic fallback: drop every digit (refs, dates, "JUL26") and month names, keep the words.
const fallbackKey = (description) => clean(String(description).replace(/\d+/g, ' ').replace(MONTHS, ' ')).slice(0, 80);

/** { name, handle, key } for a description. `name` is for display; `key` is what's matched on. */
function counterparty(description) {
  const raw = String(description || '').replace(/^(WDL|DEP)\s+TFR\s+/i, '').trim();
  const parts = raw.split('/').map((p) => p.trim());
  const head = (parts[0] || '').toUpperCase();

  if (head === 'UPI' && parts.length >= 3) {
    // SBI: UPI/DR|CR/<ref>/<name>/<bank>/<handle>/<remark>
    if (/^(DR|CR)$/i.test(parts[1]) && /^\d{6,}$/.test(parts[2].replace(/\s/g, ''))) {
      const name = clean(parts[3]);
      const bank = (parts[4] || '').replace(/\s/g, '').toUpperCase();
      const handle = BANK_CODE.test(bank) ? cleanHandle(parts[5] || '') : '';
      if (name) return { name, handle, key: handle ? `UPI ${name} @ ${handle}` : `UPI ${name}` };
    }
    // Kotak: UPI/<name>/<bank>/<ref>/<remark>
    const name = clean(parts[1]);
    if (name && !/^\d+$/.test(name)) return { name, handle: '', key: `UPI ${name}` };
  }

  // NEFT*<IFSC>*<UTR>*<name> and IMPS/<type>/<ref>/<name>/…
  if (/^NEFT\*/i.test(raw)) {
    const fields = raw.split('*').map((f) => f.trim()).filter(Boolean);
    const name = clean(fields.filter((f, i) => i > 0 && !IFSC.test(f.replace(/\s/g, '').toUpperCase()) && !/\d{5,}/.test(f)).pop());
    if (name) return { name, handle: '', key: `NEFT ${name}` };
  }
  if (head === 'IMPS' && parts.length >= 4) {
    const name = clean(parts.find((p, i) => i > 0 && /[A-Za-z]{3,}/.test(p) && !/^(P2A|P2P)$/i.test(p)));
    if (name) return { name, handle: '', key: `IMPS ${name}` };
  }

  const key = fallbackKey(raw);
  return { name: key, handle: '', key };
}

const merchantKey = (description) => counterparty(description).key;

// Too short or too generic to identify anyone ("UPI", "NEFT TFR"): never learned from or matched.
const isUsableKey = (key) => key.replace(/\b(UPI|DR|CR|NEFT|IMPS|RTGS|TFR|WDL|DEP|TO|BY|PAY|SENT|NA)\b/g, '').replace(/[@\s]/g, '').length >= 3;

module.exports = { counterparty, merchantKey, isUsableKey };
