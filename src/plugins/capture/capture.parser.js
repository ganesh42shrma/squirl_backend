// Quick Capture's rule-based reader: one line of plain text in, a list of proposed actions out.
// Pure functions only (no database, no clock): the caller passes today's date in the person's own
// timezone plus their habits and categories, which keeps every case easy to test.
//
//   "chai 40 upi"                → transaction  (debit ₹40, Cafes & Coffee, UPI)
//   "salary 85000 received"      → transaction  (credit)
//   "remind me to pay rent fri"  → task         (due next Friday)
//   "dentist tomorrow 5pm"       → task         (a date with no amount reads as a to-do)
//   "gym done" / "water 6 glasses" → habit check-in, when it names one of the person's habits
//   anything else                → note         (kept in the capture inbox to sort out later)
//
// Several things can be captured at once on separate lines or separated by ";". Inside one line,
// "chai 40 and samosa 20" / "chai 40, samosa 20 upi" also splits, but only when EVERY part has its own
// amount (so "bread and butter 60" stays one payment).
const { addDays, isoWeekday } = require('../tasks/day');

const MAX_CLAUSES = 10;
const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const ORDINARY_WORDS = new Set(['sun', 'sat', 'wed']);
const WEEKDAY_RE = '(mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:rs|rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)';
const MONTH_RE = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';

const TASK_PREFIX = /^\s*(?:remind me(?: to)?|reminder:?|todo:?|to-do:?|task:?|don'?t forget(?: to)?|need to|have to)\s+/i;
const DONE_WORDS = /\b(?:done|did|completed?|finished|checked in)\b|[✅✓✔]/gi;
const CREDIT_WORDS = /\b(?:received|recieved|earned|credited|salary|bonus|refund(?:ed)?|cashback|income|sold|reimburse(?:d|ment))\b/i;
const GOT_FROM = /\bgot\b.*\bfrom\b/i;
// "paid maid salary 8000" is money going out, even though "salary" usually means money coming in. Only a verb
// that opens the clause counts: "got paid salary 85000" and "boss gave bonus 5000" are still money in.
const PAID_OUT = /^\s*(?:(?:i|just|yesterday|today)\s+)*(?:paid|pay|gave|give|sent|send)\b/i;
const DEFAULT_DESCRIPTIONS = { debit: 'Quick expense', credit: 'Money received' };
const FILLER = /\b(?:spent|spend|paid|pay|bought|buy|for|on|at|via|using|by|with|of|rs\.?|inr|rupees?|received|recieved|got|from|credited|earned)\b/gi;

// Payment mode words → the ledger's payment mode. Bank names also set the account.
// "card" is the one that is also an everyday noun ("birthday card 100"), so it has its own rules below.
const CARD = Symbol('card');
const MODES = [
  [/\b(?:upi|gpay|google pay|phonepe|paytm|bhim)\b/i, 'upi'],
  [CARD, 'card'],
  [/\b(?:net ?banking|neft|imps|rtgs)\b/i, 'netbanking'],
  [/\bcash\b/i, 'cash'],
];
// Modes that mean "money moved through a bank", so an unnamed bank can be guessed (see contextFor).
const BANK_MODES = new Set(['upi', 'card', 'netbanking']);
// Banks named in the text become the account, so a usual-bank guess never overrides "petrol 2000 hdfc card".
// "bob" and "yes" are also ordinary words, so they only count next to a bank/mode word.
const BANKS = [
  ['sbi', 'sbi'], ['kotak', 'kotak'], ['hdfc', 'hdfc'], ['icici', 'icici'], ['axis', 'axis'], ['pnb', 'pnb'],
  ['idfc(?:\\s+first)?', 'idfc'], ['indusind', 'indusind'], ['federal\\s+bank', 'federal'], ['canara', 'canara'],
  ['yes\\s+bank', 'yes'], ['bob(?=\\s+(?:bank|card|upi|credit|debit))', 'bob'],
];
const ACCOUNTS = BANKS.map(([word, name]) => [new RegExp(`\\b${word}(?:\\s+bank)?\\b`, 'i'), name]);
const BANK_WORDS = BANKS.map(([word]) => word).join('|');
// Words that may follow a payment's amount without being part of what it was for: a mode, a bank, "done", filler.
const NOISE = new RegExp(`\\b(?:upi|gpay|google pay|phonepe|paytm|bhim|card|net ?banking|neft|imps|rtgs|cash|${BANK_WORDS}|done|did|completed?|finished|checked in)\\b`, 'gi');

// Everyday words → a default subcategory name. Used only when the person still has a category by
// that name, so renamed or deleted categories are simply skipped.
const CATEGORY_HINTS = [
  [/\b(?:chai|tea|coffee|cafe|starbucks|ccd)\b/i, 'Cafes & Coffee', 'debit'],
  [/\b(?:swiggy|zomato|food delivery)\b/i, 'Food Delivery', 'debit'],
  [/\b(?:lunch|dinner|breakfast|restaurant|biryani|meal|dine|dining)\b/i, 'Dining Out', 'debit'],
  [/\b(?:grocery|groceries|vegetables?|veggies|milk|bigbasket|blinkit|zepto|instamart|dmart)\b/i, 'Groceries', 'debit'],
  [/\b(?:snacks?|samosa|vada ?pav|pani ?puri|chaat)\b/i, 'Snacks & Street Food', 'debit'],
  // "bar" alone is also a chocolate bar or a protein bar; it means a pub only in these phrasings.
  [/\b(?:beer|pub|drinks)\b|\b(?:at|in|to)\s+(?:the\s+)?bar\b|\bbar\s+(?:bill|tab)\b|^\s*bar\b/i, 'Drinks & Bars', 'debit'],
  [/\b(?:uber|ola|rapido|auto|cab|taxi)\b/i, 'Cab & Auto', 'debit'],
  [/\b(?:metro|bus)\b/i, 'Metro & Bus', 'debit'],
  [/\b(?:petrol|diesel|fuel)\b/i, 'Fuel', 'debit'],
  [/\b(?:parking|toll|fastag)\b/i, 'Parking & Tolls', 'debit'],
  [/\brent\b/i, 'Rent', 'debit'],
  [/\b(?:electricity|power bill)\b/i, 'Electricity', 'debit'],
  [/\b(?:recharge|mobile bill)\b/i, 'Mobile Recharge', 'debit'],
  [/\b(?:wifi|wi-fi|internet|broadband)\b/i, 'Internet & Wi-Fi', 'debit'],
  [/\b(?:netflix|hotstar|prime video|jiocinema)\b/i, 'Streaming (OTT)', 'debit'],
  [/\b(?:spotify)\b/i, 'Music', 'debit'],
  [/\b(?:movie|movies|cinema|pvr|inox)\b/i, 'Movies', 'debit'],
  [/\b(?:medicines?|pharmacy|chemist)\b/i, 'Medicines', 'debit'],
  [/\b(?:doctor|clinic|consultation)\b/i, 'Doctor Visits', 'debit'],
  [/\bgym\b/i, 'Gym & Sports', 'debit'],
  [/\b(?:haircut|salon|barber)\b/i, 'Salon & Grooming', 'debit'],
  [/\b(?:books?|kindle)\b/i, 'Books', 'debit'],
  [/\bgifts?\b/i, 'Gifts', 'debit'],
  [/\bsalary\b/i, 'Monthly Salary', 'credit'],
  [/\b(?:bonus|incentive)\b/i, 'Bonus & Incentives', 'credit'],
  [/\brefund(?:ed)?\b/i, 'Refunds', 'credit'],
  [/\bcashback\b/i, 'Cashback & Rewards', 'credit'],
  [/\binterest\b/i, 'Savings Interest', 'credit'],
  [/\bfreelanc\w*\b/i, 'Freelancing', 'credit'],
];

const squash = (s) => s.replace(/\s+/g, ' ').trim();
const capitalise = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const pad = (n) => String(n).padStart(2, '0');
const tidy = (s) => capitalise(squash(s.replace(/^[\s,.:;-]+|[\s,.:;-]+$/g, '').replace(/\s+(?:by|on|at|before|for|to|and)$/i, '').replace(/^(?:to|and)\s+/i, '')));

/** Splits a capture into clauses: one per line or ";". (Splitting inside a line is splitPayments.) */
function splitClauses(text) {
  return String(text || '').split(/[\n;]+/).map(squash).filter(Boolean).slice(0, MAX_CLAUSES);
}

/** The next date (today or later) that falls on a day-of-month, rolling into the next month. */
function nextMonthDay(today, dayOfMonth, month) {
  const [y, m] = today.split('-').map(Number);
  const build = (year, mon) => {
    const last = new Date(Date.UTC(year, mon, 0)).getUTCDate();
    return dayOfMonth > last ? null : `${year}-${pad(mon)}-${pad(dayOfMonth)}`;
  };
  if (month) {
    const thisYear = build(y, month);
    return thisYear && thisYear >= today ? thisYear : build(y + 1, month);
  }
  for (let i = 0; i < 3; i += 1) {
    const mon = ((m - 1 + i) % 12) + 1;
    const year = y + Math.floor((m - 1 + i) / 12);
    const key = build(year, mon);
    if (key && key >= today) return key;
  }
  return null;
}

/** The most recent occurrence of a month-day strictly before today (this year's, else last year's). */
function lastMonthDay(today, dayOfMonth, month) {
  const [y] = today.split('-').map(Number);
  const build = (year) => (dayOfMonth > new Date(Date.UTC(year, month, 0)).getUTCDate() ? null : `${year}-${pad(month)}-${pad(dayOfMonth)}`);
  const thisYear = build(y);
  return thisYear && thisYear < today ? thisYear : build(y - 1);
}

/** The most recent day-of-month strictly before today (this month's, else the month before's). */
function previousDayOfMonth(today, dayOfMonth) {
  const [y, m] = today.split('-').map(Number);
  for (let i = 0; i < 3; i += 1) {
    const mon = ((m - 1 - i + 24) % 12) + 1;
    const year = m - 1 - i < 0 ? y - 1 : y;
    const last = new Date(Date.UTC(year, mon, 0)).getUTCDate();
    const key = dayOfMonth > last ? null : `${year}-${pad(mon)}-${pad(dayOfMonth)}`;
    if (key && key < today) return key;
  }
  return null;
}

const daysBetween = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/**
 * Pulls date and time phrases out of a clause. Returns what's left of the text, the date (YYYY-MM-DD,
 * the person's own day) and a time (HH:MM). Nothing found → nulls, text unchanged.
 */
function extractWhen(input, today) {
  let rest = ` ${input} `;
  let date = null;
  let time = null;
  let weekday = null; // { target, future } when a weekday word supplied the date
  let calendar = null; // { forward, back } when a named month-day supplied it: the next one and the latest past one
  const take = (re, fn) => {
    rest = rest.replace(re, (...m) => {
      const keep = fn(m);
      return keep === false ? m[0] : ' ';
    });
  };

  // Times first, so "5pm" never reads as an amount.
  take(/\b(?:at\s+)?(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)\b/i, (m) => {
    const h = Number(m[1]);
    const min = Number(m[2] || 0);
    if (h < 1 || h > 12 || min > 59) return false;
    time ??= `${pad((h % 12) + (m[3].toLowerCase() === 'pm' ? 12 : 0))}:${pad(min)}`;
    return true;
  });
  take(/\bat\s+([01]?\d|2[0-3]):([0-5]\d)\b/i, (m) => { time ??= `${pad(m[1])}:${m[2]}`; });
  take(/\btonight\b/i, () => { date ??= today; time ??= '21:00'; });
  take(/\b(?:this\s+)?morning\b/i, () => { time ??= '09:00'; });
  take(/\b(?:this\s+)?afternoon\b/i, () => { time ??= '14:00'; });
  take(/\b(?:this\s+)?evening\b/i, () => { time ??= '18:00'; });

  // Dates. The longer phrases go first ("day after tomorrow" before "tomorrow").
  take(/\b(\d{4})-(\d{2})-(\d{2})\b/, (m) => {
    const key = `${m[1]}-${m[2]}-${m[3]}`;
    if (Number.isNaN(Date.parse(`${key}T00:00:00Z`))) return false;
    date ??= key;
  });
  take(/\bday after (?:tomorrow|tmrw|tmr)\b/i, () => { date ??= addDays(today, 2); });
  take(/\b(?:tomorrow|tmrw|tmr|tomorow)\b/i, () => { date ??= addDays(today, 1); });
  take(/\bday before yesterday\b/i, () => { date ??= addDays(today, -2); });
  take(/\b(?:last night|yesterday(?:\s+night)?)\b/i, () => { date ??= addDays(today, -1); });
  take(/\b(?:today|tod)\b/i, () => { date ??= today; });
  take(/\bin\s+(\d{1,2})\s+(day|week)s?\b/i, (m) => { date ??= addDays(today, Number(m[1]) * (m[2].toLowerCase() === 'week' ? 7 : 1)); });
  take(/\b(\d{1,3})\s+(day|week)s?\s+ago\b/i, (m) => { date ??= addDays(today, -Number(m[1]) * (m[2].toLowerCase() === 'week' ? 7 : 1)); });
  take(/\bnext week\b/i, () => { date ??= addDays(today, 7); });
  // Global, so a first hit that is only an ordinary word ("sun lotion") doesn't hide a real "on sat" later on.
  take(new RegExp(`\\b(?:(on|by|before|till|until|every)\\s+)?(?:(next|this)\\s+)?${WEEKDAY_RE}(?:\\s+night)?\\b`, 'gi'), (m) => {
    const lead = (m[1] || '').toLowerCase();
    const which = (m[2] || '').toLowerCase();
    const word = m[3].toLowerCase();
    const str = m[m.length - 1];
    const offset = m[m.length - 2];
    // What follows the weekday, once payment modes, banks, "done" and filler words are set aside.
    const tail = squash(str.slice(offset + m[0].length).replace(NOISE, ' ').replace(FILLER, ' ').replace(/[^a-z0-9]+/gi, ' '));
    // "sun", "sat" and "wed" are also ordinary words: "sun lotion 300", "sat mat 500". They only count as a date
    // with a lead-in like "on", with a time, when nothing but modes/banks follow ("uber 230 sat upi"), or when a
    // name and an amount came first ("uber 230 sat airport"). The other short ones (mon, tue, thu, fri) are always days.
    const before = squash(str.slice(0, offset).replace(NOISE, ' ').replace(FILLER, ' '));
    const afterName = /[a-z].*\d/i.test(before);
    if (ORDINARY_WORDS.has(word) && !lead && !which && !time && tail && !afterName) return false;
    const target = WEEKDAYS.indexOf(word.slice(0, 3)) + 1;
    const ahead = (target - isoWeekday(today) + 7) % 7;
    // "fri" is the coming Friday; on a Friday it means next week's, unless it says "this fri".
    const key = addDays(today, ahead === 0 ? (which === 'this' ? 0 : 7) : ahead);
    if (date) return true; // an earlier phrase ("yesterday") already dated it; the weekday is just removed
    date = key;
    weekday = { target, future: Boolean(which) || ['by', 'before', 'till', 'until'].includes(lead) };
    return true;
  });
  const monthDay = (day, monthWord) => {
    const month = MONTHS.indexOf(monthWord.slice(0, 3).toLowerCase()) + 1;
    const key = nextMonthDay(today, day, month);
    if (!key) return false;
    if (!date) calendar = { forward: key, back: lastMonthDay(today, day, month), bare: false };
    date ??= key;
    return true;
  };
  take(new RegExp(`\\b(?:on\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_RE}\\b`, 'i'), (m) => monthDay(Number(m[1]), m[2]));
  take(new RegExp(`\\b(?:on\\s+)?${MONTH_RE}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, 'i'), (m) => monthDay(Number(m[2]), m[1]));
  take(/\bon\s+(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)\b/i, (m) => {
    const key = nextMonthDay(today, Number(m[1]));
    if (!key) return false;
    // No month named: the previous such day (this month's, else last month's) is what "on 14th" may mean for a payment.
    if (!date) calendar = { forward: key, back: previousDayOfMonth(today, Number(m[1])), bare: true };
    date ??= key;
  });

  if (time && !date) date = today;
  return { rest: squash(rest), date, time, weekday, calendar };
}

/**
 * A payment or check-in has already happened, so a bare weekday names the most recent one ("uber 230 sat"
 * is last Saturday; today counts), and a month-day that went by in the last couple of months is that one
 * ("paid 500 on 3 nov" in mid-November is this month's, not next year's). Only "next/this/by/before/till"
 * look ahead. Tasks keep the future reading.
 */
const RECENT_MONTH_DAYS = 60;
const RECENT_BARE_DAYS = 7; // "on 14th" with no month: only a day this recent reads as already gone by
// Something still to be paid ("pay rent 15000 fri", "electricity bill 1840 due fri") looks ahead; a past-tense
// verb ("paid 500 on 10 sep") always means a day that has gone by.
const FUTURE_INTENT = /\bdue\b|^\s*(?:pay|buy|send|give|book|renew)\b/i;
const PAST_VERB = /\b(?:paid|spent|bought|received|recieved|earned|credited|refunded|got|gave|sent|sold)\b/i;
function pastWhen(when, today, clause = '') {
  if (FUTURE_INTENT.test(clause)) return when;
  const cal = when.calendar;
  if (cal?.back && when.date === cal.forward) {
    const within = PAST_VERB.test(clause) ? when.date > today : daysBetween(cal.back, today) <= (cal.bare ? RECENT_BARE_DAYS : RECENT_MONTH_DAYS);
    if (within) return { ...when, date: cal.back };
  }
  if (!when.weekday || when.weekday.future) return when;
  const back = (isoWeekday(today) - when.weekday.target + 7) % 7;
  return { ...when, date: addDays(today, -back) };
}

/**
 * Finds the amount in a clause: a number with ₹/Rs/INR wins; otherwise the largest bare number
 * ("2 coffees 120" → 120). "5k" and "1.5 lakh" are understood. Returns { amount, sign, rest, before, after, marked }.
 */
function extractAmount(input) {
  const scale = (unit) => {
    const u = (unit || '').toLowerCase();
    if (u === 'k') return 1_000;
    if (u === 'l' || u.startsWith('lakh')) return 100_000;
    return 1;
  };
  const toNumber = (digits, unit) => Number(digits.replace(/,/g, '')) * scale(unit);

  const marked = /(?:₹|\brs\.?|\binr\b)\s*([+-]?)(\d[\d,]*(?:\.\d{1,2})?)\s*(k|l|lakhs?)?\b/i.exec(input)
    || /([+-]?)(\d[\d,]*(?:\.\d{1,2})?)\s*(k|l|lakhs?)?\s*(?:₹|\/-|rs\b\.?|rupees?\b|inr\b)/i.exec(input);
  let best = null;
  if (marked) best = { index: marked.index, length: marked[0].length, sign: marked[1], value: toNumber(marked[2], marked[3]) };
  else {
    const bare = /(^|[\s(])([+-]?)(\d[\d,]*(?:\.\d{1,2})?)(\s*(?:k|lakhs?)\b)?(?=$|[\s),.!?])/gi;
    for (let m = bare.exec(input); m; m = bare.exec(input)) {
      const value = toNumber(m[3], (m[4] || '').trim());
      if (!best || value > best.value) best = { index: m.index + m[1].length, length: m[0].length - m[1].length, sign: m[2], value };
    }
  }
  if (!best || !(best.value > 0) || best.value > 1e9) return { amount: null, sign: '', rest: input, before: input, after: '', marked: false };
  const after = input.slice(best.index + best.length);
  return {
    amount: Math.round(best.value * 100) / 100,
    sign: best.sign,
    rest: squash(`${input.slice(0, best.index)} ${after}`),
    before: squash(input.slice(0, best.index)), // what was typed before it
    marked: Boolean(marked), // ₹ / Rs / INR: certainly money, not a quantity ("2 samosas")
    after: squash(after), // what was typed after the amount: a trailing "card" is a payment mode
  };
}

const STOP = new Set(['the', 'and', 'for', 'with', 'did', 'done', 'today', 'my', 'a', 'an', 'of', 'to']);
const stems = (text) => squash(text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ')).split(' ')
  .filter((w) => w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w)).map((w) => w.slice(0, 4));

/**
 * A habit check-in when the clause names one of the person's habits AND says it's done ("gym done")
 * or gives a quantity in the habit's unit ("water 6 glasses"). A bare mention never checks in; the
 * exact name alone does ("gym"), unless `allowBare` is false (a dated "gym tomorrow" is a to-do).
 */
function matchHabit(clause, habits = [], { allowBare = true } = {}) {
  if (!habits.length) return null;
  const said = clause.toLowerCase();
  const done = new RegExp(DONE_WORDS.source, 'i').test(clause);
  const quantity = /(\d+(?:\.\d+)?)\s*([a-z]+)?/i.exec(clause.replace(DONE_WORDS, ' '));
  const words = new Set(stems(clause.replace(DONE_WORDS, ' ')));
  let best = null;
  for (const habit of habits) {
    const name = habit.name.toLowerCase();
    const nameStems = stems(habit.name);
    const overlap = nameStems.filter((s) => words.has(s)).length;
    const exact = allowBare && said.replace(DONE_WORDS, ' ').trim() === name;
    if (!overlap && !exact) continue;
    const unit = habit.unit && quantity?.[2] && quantity[2].toLowerCase().startsWith(habit.unit.toLowerCase().slice(0, 3));
    if (!done && !unit && !exact) continue;
    const score = overlap + (exact ? 5 : 0) + (unit ? 2 : 0);
    if (!best || score > best.score) best = { habit, score, unit };
  }
  if (!best) return null;
  const data = { habitId: best.habit.id, name: best.habit.name };
  if (best.habit.targetQuantity != null && quantity) data.quantity = Number(quantity[1]);
  return { type: 'habit', data };
}

/** A category for a captured payment: keyword hints first, then a category named in the text. */
function guessCategory(text, direction, categories = []) {
  if (!categories.length) return null;
  const byName = new Map(categories.map((c) => [c.name.toLowerCase(), c]));
  const fits = (c) => c && (direction === 'credit' ? c.type === 'income' : c.type !== 'income');
  for (const [re, name, dir] of CATEGORY_HINTS) {
    if (dir !== direction || !re.test(text)) continue;
    const c = byName.get(name.toLowerCase());
    if (fits(c)) return c;
  }
  const lower = ` ${text.toLowerCase()} `;
  const named = categories
    .filter((c) => c.name.length >= 4 && fits(c) && lower.includes(` ${c.name.toLowerCase()} `))
    .sort((x, y) => Number(Boolean(y.parentId)) - Number(Boolean(x.parentId)) || y.name.length - x.name.length);
  return named[0] || null;
}

/** The payment mode in a clause, and the text left once its words are removed. "card" needs care. */
function readMode(rest, after) {
  for (const [re, mode] of MODES) {
    if (re !== CARD) {
      if (re.test(rest)) return { mode, rest: rest.replace(new RegExp(re.source, 'gi'), ' ') };
      continue;
    }
    // "credit card" always means the payment method; so does "by/via/on card" or "sbi card", and a
    // "card" typed after the amount ("chai 40 card"). "birthday card 100" does not.
    const named = /\b(?:credit|debit)\s+card\b/i;
    const lead = new RegExp(`(?<=\\b(?:by|via|using|with|on|through|${BANK_WORDS})\\s+)card\\b`, 'i');
    if (named.test(rest)) return { mode, rest: rest.replace(named, ' ') };
    if (lead.test(rest)) return { mode, rest: rest.replace(lead, ' ') };
    if (/\bcard\b/i.test(after)) return { mode, rest: rest.replace(/\bcard\b(?!.*\bcard\b)/i, ' ') };
  }
  return { rest };
}

/** Does this clause read as money coming in? */
function readsAsCredit(clause) {
  const word = CREDIT_WORDS.exec(clause)?.[0].toLowerCase();
  if (word) return !(PAID_OUT.test(clause) && /^(?:salary|bonus|income)$/.test(word));
  // "got 500 from dad" is income, "got milk from dmart 60" is shopping.
  return GOT_FROM.test(clause) && !CATEGORY_HINTS.some(([re, , dir]) => dir === 'debit' && re.test(clause));
}

function parseTransaction(clause, amountInfo, when, ctx, inherit = {}) {
  // The amount was read from the date-free text, so a date like "25 dec" never becomes the amount.
  let rest = amountInfo.rest;
  // A later part of "got 500 from dad and 300 from mom" has no verb of its own and takes the sentence's direction.
  const direction = amountInfo.sign === '+' ? 'credit' : amountInfo.sign === '-' ? 'debit'
    : inherit.direction || (readsAsCredit(clause) ? 'credit' : 'debit');
  const read = readMode(rest, amountInfo.after);
  rest = read.rest;
  // Words that only the last part of "chai 40 and samosa 20 upi" typed apply to the parts before it too.
  const paymentMode = read.mode || inherit.paymentMode;
  let account;
  for (const [re, name] of ACCOUNTS) if (re.test(rest)) { account = name; rest = rest.replace(new RegExp(re.source, 'gi'), ' '); break; }
  account ||= inherit.account;
  // UPI, card and net banking always go through a bank. With none named, assume the person's usual one.
  if (!account && BANK_MODES.has(paymentMode) && ctx.bankAccount) account = ctx.bankAccount;
  const description = tidy(rest.replace(FILLER, ' ')) || DEFAULT_DESCRIPTIONS[direction];
  const category = guessCategory(clause, direction, ctx.categories);
  return {
    type: 'transaction',
    data: {
      date: when.date && when.date <= ctx.today ? when.date : ctx.today,
      description: description.slice(0, 500),
      amount: amountInfo.amount,
      direction,
      ...(category && { category: category.id, categoryName: category.name }),
      ...(paymentMode && { paymentMode }),
      ...(account && { account }),
    },
  };
}

function parseTask(text, when) {
  const title = tidy(when.rest.replace(TASK_PREFIX, ''));
  if (!title) return null;
  return { type: 'task', data: { title: title.slice(0, 200), dueDate: when.date, dueTime: when.time } };
}

/** The words a trailing part shares with the parts before it: "chai 40 and samosa 20 upi yesterday". */
function sharedWords(part, today) {
  const when = extractWhen(part, today);
  const amount = extractAmount(when.rest);
  const read = readMode(amount.rest, amount.after);
  const account = ACCOUNTS.find(([re]) => re.test(read.rest))?.[1];
  return { date: pastWhen(when, today, part).date || undefined, paymentMode: read.mode, account };
}

// Verbs that say which way money moved; "salary" and "bonus" alone do not (they depend on who paid whom).
const STRONG_VERB = /\b(?:spent|spend|paid|pay|bought|buy|gave|give|sent|send|received|recieved|earned|credited|got|sold|refund(?:ed)?|cashback|reimburse(?:d|ment))\b/i;
const OPENS_WITH_SPEND = /^\s*(?:(?:i|just|yesterday|today)\s+)*(?:spent|spend|paid|pay|bought|buy|gave|give|sent|send)\b/i;
const directionOf = (clause, sign) => (sign === '+' ? 'credit' : sign === '-' ? 'debit' : readsAsCredit(clause) ? 'credit' : 'debit');

// A comma that is part of an amount ("1,250") never splits.
const PAYMENT_SEPARATOR = /\s*,(?!\d)\s*|\s+and\s+/i;

/**
 * "chai 40 and samosa 20" → two clauses. Splits on "and" or "," ONLY when every part has its own amount
 * and a name (so "bread and butter 60" and "lunch with raj and priya 500" stay whole). Reminders are
 * never split. Returns [{ text, inherit }], where `inherit` is what the last part's modifiers lend.
 */
function splitPayments(clause, today) {
  const whole = [{ text: clause, inherit: {} }];
  if (TASK_PREFIX.test(clause)) return whole;
  const parts = clause.split(PAYMENT_SEPARATOR).map(squash).filter(Boolean);
  if (parts.length < 2) return whole;
  // A part reads "name amount" (chai 40) or "amount name" (40 chai). Mixing them ("chai 40 and 2 samosas") means
  // one of the numbers is a quantity, not a price, so it is not split. A ₹-marked amount fits either shape.
  const words = (text) => squash(text.replace(NOISE, ' ').replace(FILLER, ' ').replace(/[^a-z]+/gi, ' '));
  const shapeOf = (part) => {
    const amount = extractAmount(extractWhen(part, today).rest);
    if (amount.amount == null) return null;
    const nameFirst = Boolean(words(amount.before));
    if (!nameFirst && !words(amount.after)) return null;
    return amount.marked ? 'any' : nameFirst ? 'name-first' : 'amount-first';
  };
  const shapes = parts.map(shapeOf);
  if (shapes.includes(null) || new Set(shapes.filter((x) => x !== 'any')).size > 1) return whole;
  // "paid 500 for lunch, 2 people" / "500 lunch, 2 beers": a small count after a spend verb or a big price is a
  // quantity, not a second payment. A later part that has its own verb or "for/to/at/on/from" is a payment.
  const firstAmount = extractAmount(extractWhen(parts[0], today).rest).amount;
  for (let i = 1; i < parts.length; i += 1) {
    if (shapes[i] !== 'amount-first') continue;
    const info = extractAmount(extractWhen(parts[i], today).rest);
    const small = !info.marked && Number.isInteger(info.amount) && info.amount <= 10 && firstAmount >= info.amount * 5;
    const bare = !STRONG_VERB.test(parts[i]) && !/\b(?:for|to|at|on|from)\b/i.test(parts[i]);
    if (small || (OPENS_WITH_SPEND.test(parts[0]) && bare)) return whole;
  }
  const inherit = sharedWords(parts[parts.length - 1], today);
  // The sentence's direction comes from its first part, when that part has a verb ("paid maid salary 8000 and
  // driver salary 10000" is money out twice); later parts with a verb or sign of their own keep it.
  const first = extractAmount(extractWhen(parts[0], today).rest);
  const lead = STRONG_VERB.test(parts[0]) ? directionOf(parts[0], first.sign) : undefined;
  return parts.map((text, i) => ({
    text,
    inherit: {
      ...(i < parts.length - 1 && inherit),
      ...(i > 0 && lead && !STRONG_VERB.test(text) && !/^\s*[+-]|\s[+-]\d/.test(text) && { direction: lead }),
    },
  }));
}

/** One clause → one action. `inherit` carries date, mode and bank shared from a later part of the line. */
function parseClause(clause, ctx, inherit = {}) {
  const prefixed = TASK_PREFIX.test(clause);
  const when = extractWhen(prefixed ? clause.replace(TASK_PREFIX, '') : clause, ctx.today);
  if (prefixed) return parseTask(clause.replace(TASK_PREFIX, ''), when) || { type: 'note', data: { text: clause } };
  if (!when.date && inherit.date) when.date = inherit.date;

  // A check-in is about something done: the day it names must be one the habit can still be checked in for.
  const checkedWhen = pastWhen(when, ctx.today, clause);
  // A bare habit name is a check-in when it names a day already gone ("gym yesterday"); "gym today 6pm" or
  // "gym tomorrow" are to-dos.
  const habit = matchHabit(when.rest, ctx.habits, { allowBare: !when.time && (!when.date || when.date < ctx.today) });
  if (habit) {
    const asNote = { type: 'note', data: { text: clause.slice(0, 500) } };
    const meta = ctx.habits.find((h) => h.id === habit.data.habitId);
    // A habit that isn't scheduled that day (a weekdays-only habit on Sunday) is refused by the habit service,
    // which would fail the whole save; keep the words as a note instead.
    if (meta?.unscheduled?.includes(checkedWhen.date || ctx.today)) return asNote;
    if (!checkedWhen.date) return habit;
    // "gym done tomorrow" can't be a check-in, and a task called "Gym done" would be nonsense.
    if (checkedWhen.date > ctx.today) return asNote;
    const earliest = ctx.checkinFrom || addDays(ctx.today, -1);
    // Too old (or before the habit began) would make the habit service refuse and fail the whole save.
    if (checkedWhen.date < earliest || (meta?.startDate && checkedWhen.date < meta.startDate)) return asNote;
    return { ...habit, data: { ...habit.data, date: checkedWhen.date } };
  }

  const amountInfo = extractAmount(when.rest);
  if (amountInfo.amount) {
    const paid = pastWhen(when, ctx.today, clause);
    // Money due in the future is something to do, not something that happened: "rent 15000 on 1st".
    if (paid.date && paid.date > ctx.today) return parseTask(clause, paid);
    return parseTransaction(clause, amountInfo, paid, ctx, inherit);
  }
  if (when.date || when.time) {
    const task = parseTask(clause, when);
    if (task) return task;
  }
  return { type: 'note', data: { text: clause.slice(0, 500) } };
}

/**
 * parse('chai 40 upi; gym done', { today: '2026-11-15', habits, categories })
 * → { actions: [...], understood } — `understood` is false when everything fell through to a note.
 * `bankAccount` (the person's usual bank) and `checkinFrom` (the oldest day a habit accepts) are optional, as is
 * a habit's `unscheduled` list (days it can't be checked in because its schedule skips them).
 */
function parse(text, { today, habits = [], categories = [], bankAccount, checkinFrom }) {
  const ctx = { today, habits, categories, bankAccount, checkinFrom };
  const actions = splitClauses(text)
    .flatMap((clause) => splitPayments(clause, today).map((part) => parseClause(part.text, ctx, part.inherit)))
    .slice(0, MAX_CLAUSES); // the save is capped at the same number, so a preview can always be saved
  return { actions, understood: actions.length > 0 && actions.some((a) => a.type !== 'note') };
}

module.exports = { parse, parseClause, splitClauses, splitPayments, extractWhen, extractAmount, matchHabit, guessCategory, MAX_CLAUSES, DEFAULT_DESCRIPTIONS };
