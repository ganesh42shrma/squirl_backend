// Which kinds of item can hold photos, and the view listing each kind's live (not deleted) rows. Table and view
// names come from this list only, never from input. A capture is live only while it waits in the inbox.
const OWNER_VIEWS = Object.freeze({
  transaction: 'active_transactions',
  task: 'active_tasks',
  goal: 'active_goals',
  commitment: 'active_commitments',
  habit: 'active_habits',
  capture: 'inbox_captures',
  user: 'avatar_owners', // the profile picture; owner_id is the account's own id
});
const OWNER_TYPES = Object.keys(OWNER_VIEWS);

module.exports = { OWNER_VIEWS, OWNER_TYPES };
