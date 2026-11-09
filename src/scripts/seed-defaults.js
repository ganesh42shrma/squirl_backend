// Re-adds any missing default categories and tags for one account.
// New accounts get them automatically; this is for restoring defaults you deleted.
//   npm run seed -- you@example.com
// Safe to re-run: existing entries, and any edits you made to them, are left untouched.
const { connectDB, disconnectDB, getDb } = require('../config/db');
const logger = require('../core/logger');
const { seedDefaults } = require('../plugins/users/defaults');

async function seed() {
  const email = process.argv[2];
  if (!email) {
    console.error('Usage: npm run seed -- <account email>');
    process.exit(1);
  }
  await connectDB();
  const db = getDb();
  const user = db.prepare('SELECT id FROM users WHERE email = ?').get(email.trim().toLowerCase());
  if (!user) throw new Error(`No account with the email ${email}`);
  const { categoriesAdded, tagsAdded } = db.transaction(() => seedDefaults(db, user.id))();
  logger.info(`Seed complete: ${categoriesAdded} categories and ${tagsAdded} tags added`);
  await disconnectDB();
}

seed().catch(async (err) => {
  logger.error('Seeding failed', { error: err.message });
  await disconnectDB().catch(() => {});
  process.exit(1);
});
