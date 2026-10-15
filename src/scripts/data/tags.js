// Default tag catalog, grouped. Tags cut across categories: a "Dates" expense can also be "splurge" + "weekend".
module.exports = [
  { group: 'nature', color: '#10b981', tags: ['need', 'want', 'impulse', 'splurge', 'planned'] },
  { group: 'people', color: '#6366f1', tags: ['solo', 'friends', 'family', 'partner', 'colleagues', 'roommates'] },
  {
    group: 'occasion',
    color: '#f43f5e',
    tags: ['birthday', 'festival', 'date-night', 'anniversary', 'wedding', 'trip', 'party', 'weekend'],
  },
  {
    group: 'payment',
    color: '#0ea5e9',
    tags: ['split', 'reimbursable', 'cashback', 'no-cost-emi', 'recurring', 'one-time', 'refund-pending'],
  },
  { group: 'goals', color: '#f59e0b', tags: ['self-care', 'upskilling', 'health-goal', 'saving-goal', 'side-project'] },
  { group: 'lifestyle', color: '#8b5cf6', tags: ['late-night', 'office-day', 'wfh'] },
];
