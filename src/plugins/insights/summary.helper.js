const { formatInr, formatDate } = require('./insights.helper');

const SYSTEM_PROMPT = `Act as a senior financial analyst reviewing a person's recorded cash flow. Give them a useful overview and practical suggestions, not an English translation of the tables.
Reason carefully about the supplied evidence before answering. Return only your final analysis.
Your analysis should:
- Lead with the most important pattern: cash-flow resilience, a shortfall, spending concentration, changing spending, or investments putting pressure on available cash. Explain why it matters.
- Interpret trends and trade-offs using the supplied comparisons. Distinguish spending from investing and transfers. A negative amount left over after investing does not, by itself, prove overspending, borrowing or financial distress.
- Finish with two or three prioritized, realistic actions tied to the observed pattern. Explain what each action would improve. Suggestions may cover reviewing a dominant category, checking recurring costs, maintaining a cash buffer, or checking missing records. Do not give generic advice unrelated to these facts.
- Treat the data as a ledger, not a complete financial profile. No recorded income does not mean no income. Missing balances, uncategorized transactions, empty months and partial months limit conclusions. Do not compare a partial month with a full month as evidence that spending has fallen or risen. Do not infer debts, goals, household needs or motives.
- Separate what the figures show from possible explanations. Use conditional language for explanations or suggestions that depend on information you do not have. Do not assume a category's entire spend is avoidable.
Numbers and format:
- The backend has already calculated the totals, changes, ratios and percentages. You may compare and interpret them; do not perform new arithmetic or invent numeric targets. Copy any amount or percentage exactly from the facts. Use only a few numbers that support the key conclusions.
- Write around 150 to 220 words in three short paragraphs: overview, interpretation, then next steps. Speak directly to "you" in clear, professional English. Use less if the data is sparse.
- Plain text only; no headings, lists, markdown or reasoning trace. No recommendations for specific securities, financial products or promised returns.`;

// The client reserves additional tokens for reasoning separately from this answer allowance.
const SUMMARY_OPTIONS = Object.freeze({ maxTokens: 1100, reasoning: 'medium', temperature: 0.2 });
const lastDay = (month) => {
  const [year, value] = month.split('-').map(Number);
  return `${month}-${String(new Date(Date.UTC(year, value, 0)).getUTCDate()).padStart(2, '0')}`;
};
const percentage = (amount, base) => base > 0 ? `${Math.round(amount / base * 100)}%` : null;

// Aggregates only: transaction descriptions, notes, references and contact details stay out.
function toFacts(history) {
  const { totals } = history;
  const fullMonths = history.months.filter((month) => `${month.month}-01` >= history.from && lastDay(month.month) <= history.to);
  const latest = fullMonths.at(-1);
  const previous = fullMonths.at(-2);
  return {
    period: `${formatDate(history.from)} to ${formatDate(history.to)}`,
    totals: {
      earned: formatInr(totals.earned), spent: formatInr(totals.spent), invested: formatInr(totals.invested),
      leftOverAfterInvesting: formatInr(totals.net),
      leftOverBeforeInvesting: formatInr(totals.earned - totals.spent),
      leftOverShareOfRecordedIncome: percentage(totals.net, totals.earned),
    },
    dataQuality: {
      uncategorizedTransactions: totals.unsortedCount || 0,
      hasRecordedIncome: totals.earned > 0,
      hasBalanceHistory: Boolean(history.balance),
      startsMidMonth: !history.from.endsWith('-01'),
      endsMidMonth: history.to !== lastDay(history.to.slice(0, 7)),
      monthsWithoutRecordedActivity: history.months.filter((m) => !m.earned && !m.spent && !m.invested).map((m) => m.label),
      scope: 'Recorded activity only. A full calendar month in the selected range does not guarantee complete statement coverage.',
    },
    months: history.months.map((m) => ({
      month: m.label, earned: formatInr(m.earned), spent: formatInr(m.spent), invested: formatInr(m.invested),
      leftOverAfterInvesting: formatInr(m.net),
      fullCalendarMonthInRange: `${m.month}-01` >= history.from && lastDay(m.month) <= history.to,
      ...(m.balance != null && { endBalance: formatInr(m.balance) }),
    })),
    latestFullMonthComparison: latest && previous ? {
      from: previous.label, to: latest.label,
      spendingChange: formatInr(latest.spent - previous.spent),
      spendingChangePercent: percentage(latest.spent - previous.spent, previous.spent),
      recordedIncomeChange: formatInr(latest.earned - previous.earned),
      afterInvestingChange: formatInr(latest.net - previous.net),
    } : null,
    balance: history.balance ? {
      start: formatInr(history.balance.start), end: formatInr(history.balance.end),
      change: formatInr(history.balance.end - history.balance.start),
      from: formatDate(history.balance.startDate), to: formatDate(history.balance.endDate),
    } : null,
    highlights: history.highlights.filter((h) => h.id !== 'biggest').map((h) => `${h.title}: ${h.value} (${h.detail})`),
    spendingByCategory: history.topCategories.map((c) => `${c.label}: ${formatInr(c.amount)} (${c.share}%)`),
  };
}

module.exports = { SYSTEM_PROMPT, SUMMARY_OPTIONS, toFacts };
