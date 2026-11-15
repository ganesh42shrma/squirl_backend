// Which kinds of item can hold photos, and the view listing each kind's live (not deleted) rows. Table and view
// names come from this list only, never from input. A capture is live only while it waits in the inbox.
const OWNER_VIEWS = Object.freeze({
  transaction: 'active_transactions',
  task: 'active_tasks',
  goal: 'active_goals',
  commitment: 'active_commitments',
  capture: 'inbox_captures',
});
const OWNER_TYPES = Object.keys(OWNER_VIEWS);

module.exports = { OWNER_VIEWS, OWNER_TYPES };
