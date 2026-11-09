// Checks that every amount and percentage a model wrote came from the facts it was given.
// Small models are fluent but unreliable at arithmetic, so the app never trusts a number it didn't compute.

const UNITS = { lakh: 1e5, lakhs: 1e5, l: 1e5, crore: 1e7, crores: 1e7, cr: 1e7, k: 1e3 };

const toNumber = (text) => Number(text.replace(/,/g, ''));

// "4.2 lakh" claims precision to 0.1 lakh, so it's honest for anything within ±0.05 lakh (₹5,000).
const halfStep = (digits, unit) => {
  const decimals = (digits.split('.')[1] || '').length;
  return 0.5 * 10 ** -decimals * unit;
};

/** Every number that appears in the facts (₹ amounts, percentages, counts…). */
function numbersIn(facts) {
  const text = typeof facts === 'string' ? facts : JSON.stringify(facts);
  return new Set((text.match(/\d[\d,]*(?:\.\d+)?/g) || []).map(toNumber));
}

/**
 * Amounts (₹1,23,456 · ₹4.2 lakh · Rs 500) and percentages (34%) in the model's text.
 * Plain numbers like years or day-of-month aren't checked: they aren't the risky part.
 */
function claimsIn(text) {
  const claims = [];
  const amount = /(?:₹|rs\.?|inr)\s?(\d[\d,]*(?:\.\d+)?)(?:\s?(lakhs?|crores?|cr|l|k)\b)?/gi;
  for (const m of text.matchAll(amount)) {
    const unit = m[2] ? UNITS[m[2].toLowerCase()] : 1;
    claims.push({ text: m[0].trim(), value: toNumber(m[1]) * unit, kind: unit === 1 ? 'exact' : 'rounded', tolerance: halfStep(m[1], unit) });
  }
  const spelled = /(\d[\d,]*(?:\.\d+)?)\s?(lakhs?|crores?)\b/gi; // "4.2 lakh" without a ₹
  for (const m of text.matchAll(spelled)) {
    if (claims.some((c) => c.text.includes(m[0]))) continue;
    const unit = UNITS[m[2].toLowerCase()];
    claims.push({ text: m[0].trim(), value: toNumber(m[1]) * unit, kind: 'rounded', tolerance: halfStep(m[1], unit) });
  }
  for (const m of text.matchAll(/(\d+(?:\.\d+)?)\s?%/g)) {
    claims.push({ text: m[0].trim(), value: Number(m[1]), kind: 'exact' });
  }
  return claims;
}

/**
 * { ok, unverified: ['₹5,000', '12%'] }. An exact amount must appear in the facts as written;
 * a rounded one ("₹4.2 lakh") must match a fact to the precision it states.
 */
function checkNumbers(text, facts) {
  const allowed = [...numbersIn(facts)];
  const unverified = claimsIn(text)
    .filter((claim) =>
      claim.kind === 'exact'
        ? !allowed.includes(claim.value)
        : !allowed.some((v) => Math.abs(v - claim.value) <= claim.tolerance),
    )
    .map((claim) => claim.text);
  return { ok: unverified.length === 0, unverified: [...new Set(unverified)] };
}

module.exports = { checkNumbers, claimsIn, numbersIn };
