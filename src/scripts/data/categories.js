// Default categories. Subcategories inherit the parent's type and color.
module.exports = [
  // ── Expenses ──────────────────────────────────────────────
  {
    name: 'Food & Drinks', type: 'expense', icon: '🍔', color: '#f97316',
    children: ['Food Delivery', 'Dining Out', 'Cafes & Coffee', 'Groceries', 'Snacks & Street Food', 'Drinks & Bars'],
  },
  {
    name: 'Transport', type: 'expense', icon: '🚕', color: '#0ea5e9',
    children: ['Cab & Auto', 'Metro & Bus', 'Fuel', 'Vehicle Service & Repairs', 'Parking & Tolls', 'Bike & Car Rental'],
  },
  {
    name: 'Housing', type: 'expense', icon: '🏠', color: '#a855f7',
    children: ['Rent', 'Society Maintenance', 'Furniture & Appliances', 'Home Supplies', 'House Help', 'Home Repairs'],
  },
  {
    name: 'Bills & Utilities', type: 'expense', icon: '💡', color: '#eab308',
    children: ['Electricity', 'Mobile Recharge', 'Internet & Wi-Fi', 'Gas Cylinder', 'Water', 'DTH & Cable'],
  },
  {
    name: 'Subscriptions', type: 'expense', icon: '🔁', color: '#6366f1',
    children: ['Streaming (OTT)', 'Music', 'Apps & Cloud Storage', 'AI Tools', 'Memberships'],
  },
  {
    name: 'Shopping', type: 'expense', icon: '🛍️', color: '#ec4899',
    children: ['Clothing', 'Footwear', 'Electronics & Gadgets', 'Accessories', 'Home Decor'],
  },
  {
    name: 'Personal Care', type: 'expense', icon: '💇', color: '#f472b6',
    children: ['Salon & Grooming', 'Skincare & Cosmetics', 'Toiletries', 'Laundry & Dry Cleaning'],
  },
  {
    name: 'Health & Fitness', type: 'expense', icon: '💪', color: '#ef4444',
    children: ['Gym & Sports', 'Doctor Visits', 'Medicines', 'Lab Tests', 'Supplements', 'Therapy & Mental Health'],
  },
  {
    name: 'Insurance', type: 'expense', icon: '🛡️', color: '#64748b',
    children: ['Health Insurance', 'Term Insurance', 'Vehicle Insurance', 'Gadget Insurance'],
  },
  {
    name: 'Entertainment', type: 'expense', icon: '🎬', color: '#8b5cf6',
    children: ['Movies', 'Concerts & Events', 'Gaming', 'Hobbies', 'Parties & Nightlife'],
  },
  {
    name: 'Travel', type: 'expense', icon: '✈️', color: '#06b6d4',
    children: ['Flights', 'Trains & Buses', 'Hotels & Stays', 'Sightseeing & Activities', 'Visa & Forex'],
  },
  {
    name: 'Education & Growth', type: 'expense', icon: '📚', color: '#14b8a6',
    children: ['Courses & Certifications', 'Books', 'Exam & Application Fees', 'Workshops & Events', 'Coaching'],
  },
  {
    name: 'Social & Gifts', type: 'expense', icon: '🎁', color: '#f43f5e',
    children: ['Gifts', 'Treating Friends', 'Dates', 'Weddings & Functions', 'Donations & Charity'],
  },
  {
    name: 'Family', type: 'expense', icon: '👨‍👩‍👧', color: '#84cc16',
    children: ['Sent to Parents', 'Siblings', 'Household Contribution', 'Family Events'],
  },
  {
    name: 'Pets', type: 'expense', icon: '🐾', color: '#d97706',
    children: ['Pet Food', 'Vet & Medicines', 'Pet Grooming', 'Pet Supplies'],
  },
  {
    name: 'Work & Career', type: 'expense', icon: '💼', color: '#475569',
    children: ['Work Equipment', 'Coworking', 'Job Search', 'Business Expenses'],
  },
  {
    name: 'Loans & EMI', type: 'expense', icon: '💳', color: '#dc2626',
    children: ['Education Loan', 'Personal Loan', 'Vehicle Loan', 'Gadget EMI', 'Buy Now Pay Later'],
  },
  {
    name: 'Fees & Charges', type: 'expense', icon: '🏦', color: '#78716c',
    children: ['Bank Charges', 'Credit Card Fees & Interest', 'Late Fees & Penalties', 'Convenience Fees'],
  },
  {
    name: 'Taxes', type: 'expense', icon: '🧾', color: '#57534e',
    children: ['Income Tax', 'Advance Tax', 'Professional Tax'],
  },
  {
    name: 'Miscellaneous', type: 'expense', icon: '📦', color: '#9ca3af',
    children: ['Cash Spends', 'Other'],
  },

  // ── Income ────────────────────────────────────────────────
  {
    name: 'Salary', type: 'income', icon: '💰', color: '#16a34a',
    children: ['Monthly Salary', 'Bonus & Incentives', 'Work Reimbursements', 'Stipend'],
  },
  {
    name: 'Side Hustle', type: 'income', icon: '🧑‍💻', color: '#22c55e',
    children: ['Freelancing', 'Tutoring', 'Content & Creator Income', 'Selling Stuff'],
  },
  {
    name: 'Returns & Interest', type: 'income', icon: '📈', color: '#059669',
    children: ['Savings Interest', 'FD Interest', 'Dividends', 'Profit Booking'],
  },
  {
    name: 'Refunds & Cashback', type: 'income', icon: '↩️', color: '#10b981',
    children: ['Refunds', 'Cashback & Rewards'],
  },
  {
    name: 'Gifts & Family Support', type: 'income', icon: '🎉', color: '#4ade80',
    children: ['From Family', 'Gifts Received'],
  },
  { name: 'Other Income', type: 'income', icon: '💵', color: '#86efac' },

  // ── Investments ───────────────────────────────────────────
  { name: 'Mutual Funds', type: 'investment', icon: '📊', color: '#2563eb', children: ['SIP', 'Lumpsum'] },
  { name: 'Stocks & ETFs', type: 'investment', icon: '📉', color: '#1d4ed8', children: ['Stocks', 'ETFs', 'IPOs'] },
  { name: 'Deposits', type: 'investment', icon: '🏛️', color: '#3b82f6', children: ['Fixed Deposit', 'Recurring Deposit'] },
  { name: 'Retirement', type: 'investment', icon: '🧓', color: '#1e40af', children: ['PPF', 'NPS', 'EPF / VPF'] },
  {
    name: 'Gold & Alternatives', type: 'investment', icon: '🪙', color: '#ca8a04',
    children: ['Digital Gold', 'Sovereign Gold Bonds', 'Crypto'],
  },
  { name: 'Emergency Fund', type: 'investment', icon: '🧯', color: '#60a5fa' },

  // ── Transfers (moving your own money – not spending) ─────
  {
    name: 'Self Transfers', type: 'transfer', icon: '🔄', color: '#6b7280',
    children: ['Between My Accounts', 'Credit Card Bill', 'Wallet Top-up', 'ATM Withdrawal', 'Cash Deposit'],
  },

  // ── Lending (friends, splits) ─────────────────────────────
  {
    name: 'Lent & Borrowed', type: 'lending', icon: '🤝', color: '#f59e0b',
    children: ['Lent to Someone', 'Got Paid Back', 'Borrowed', 'Paid Back', 'Split Bills'],
  },
];
