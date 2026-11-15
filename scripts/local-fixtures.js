// Fictional demo data only, seeded once. Existing accounts/edits are never replaced on restart.
const { EMAIL } = require('./local-settings');
const { hashPassword } = require('../src/core/password');
const { insertUser } = require('../src/plugins/users/user.model');
const { seedDefaults } = require('../src/plugins/users/defaults');
const { insertTransaction } = require('../src/plugins/transactions/transaction.model');
const { insertCommitment } = require('../src/plugins/commitments/commitment.model');
const { insertRow, newId, nowIso } = require('../src/core/sql');

const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

function samplePayment(db, userId) {
  return db.transaction(() => {
    const id = insertTransaction(db, userId, { date: today(), description: 'Demo UPI payment · fictional local test data', amount: 75,
      type: 'debit', account: 'sbi', paymentMode: 'upi', source: 'sms', tags: ['local-demo'] });
    require('../src/plugins/notifications/payment-prompts').record(db, userId, id);
    return id;
  })();
}

/** Point the demo login at the configured password (used once when an older setup gains one). */
async function setDemoPassword(db, password) {
  const passwordHash = await hashPassword(password);
  db.prepare('UPDATE users SET password_hash = ? WHERE email = ?').run(passwordHash, EMAIL);
}

async function seedLocal(db, password) {
  if (db.prepare('SELECT count(*) FROM users').pluck().get()) return false;
  const passwordHash = await hashPassword(password);
  db.transaction(() => {
    const userId = insertUser(db, { email: EMAIL, name: 'Local Demo', passwordHash });
    seedDefaults(db, userId);
    const stamp = nowIso(), date = today();
    const category = (name) => db.prepare('SELECT id FROM active_categories WHERE user_id = ? AND name = ?').get(userId, name)?.id;
    const [year, month] = date.split('-').map(Number);
    for (let offset = 5; offset >= 0; offset--) {
      const start = new Date(Date.UTC(year, month - 1 - offset, 1)).toISOString().slice(0, 7);
      for (const [day, description, amount, type, name] of [
        ['01', 'Demo salary', 65000, 'credit', 'Monthly Salary'],
        ['02', 'Demo rent', 14000, 'debit', 'Rent'],
        ['03', 'Demo groceries', 2450 + offset * 100, 'debit', 'Groceries'],
        ['04', 'Demo coffee', 180, 'debit', 'Cafes & Coffee'],
        ['05', 'Demo car loan payment', 8000, 'debit', 'Vehicle Loan'],
      ]) {
        const when = `${start}-${day}`;
        if (when <= date) insertTransaction(db, userId, { date: when, description, amount, type, category: category(name), account: 'sbi', tags: ['local-demo'] });
      }
    }
    insertCommitment(db, userId, { kind: 'loan', name: 'Demo car loan', amount: 8000, dueDay: 5, startDate: `${year}-01-05`, account: 'sbi', category: category('Vehicle Loan'), matchKey: 'Demo car loan', principal: 380000, interestRate: 9, tenureMonths: 48 });
    insertCommitment(db, userId, { kind: 'subscription', name: 'Demo internet bill', amount: 699, dueDay: 20, startDate: `${year}-01-20`, category: category('Internet & Wi-Fi') });
    for (const [index, title] of ['Try the local dashboard', 'Add a note to a demo payment', 'Review the demo ledger'].entries()) {
      insertRow(db, 'tasks', { id: newId(), user_id: userId, title, due_date: date, position: index, created_at: stamp, updated_at: stamp });
    }
    for (const [index, name] of ['Read 10 pages', 'Walk for 20 minutes'].entries()) {
      insertRow(db, 'habits', { id: newId(), user_id: userId, name, start_date: date, position: index, created_at: stamp, updated_at: stamp });
    }
    insertRow(db, 'goals', { id: newId(), user_id: userId, name: 'Demo emergency fund', kind: 'other', price_paise: 15000000, price_as_of: date,
      plan: 'by_amount', monthly_paise: 500000, opening_paise: 2500000, start_date: date, created_at: stamp, updated_at: stamp });
    samplePayment(db, userId);
  })();
  return true;
}

module.exports = { seedLocal, samplePayment, setDemoPassword };
