const Tag = require('./tag.model');
const Transaction = require('../transactions/transaction.model');
const AppError = require('../../core/AppError');

const { CUSTOM_GROUP } = Tag;

/**
 * Catalog tags with their usage counts, plus any tag used on a transaction
 * that isn't in the catalog yet (listed under the "custom" group with no id).
 */
async function listTags({ group }) {
  const [catalog, usage] = await Promise.all([
    Tag.find().lean(),
    Transaction.aggregate([{ $unwind: '$tags' }, { $group: { _id: '$tags', count: { $sum: 1 } } }]),
  ]);

  const counts = new Map(usage.map((u) => [u._id, u.count]));
  const known = new Set(catalog.map((t) => t.name));

  const tags = [
    ...catalog.map((t) => ({ ...t, count: counts.get(t.name) || 0 })),
    ...usage
      .filter((u) => !known.has(u._id))
      .map((u) => ({ _id: null, name: u._id, group: CUSTOM_GROUP, color: null, count: u.count })),
  ];

  return tags
    .filter((t) => !group || t.group === group)
    .sort((a, b) => a.group.localeCompare(b.group) || b.count - a.count || a.name.localeCompare(b.name));
}

async function createTag(data) {
  return Tag.create(data);
}

// Renaming a tag renames it on every transaction too.
async function updateTag(id, data) {
  const tag = await Tag.findById(id);
  if (!tag) throw AppError.notFound('Tag not found');

  const oldName = tag.name;
  tag.set(data);
  await tag.save();

  if (tag.name !== oldName) {
    await Transaction.updateMany({ tags: oldName }, { $addToSet: { tags: tag.name } });
    await Transaction.updateMany({ tags: oldName }, { $pull: { tags: oldName } });
  }
  return tag;
}

// Deleting a tag removes it from the catalog and from every transaction.
async function deleteTag(id) {
  const tag = await Tag.findByIdAndDelete(id);
  if (!tag) throw AppError.notFound('Tag not found');

  const { modifiedCount } = await Transaction.updateMany({ tags: tag.name }, { $pull: { tags: tag.name } });
  return { removedFromTransactions: modifiedCount };
}

module.exports = { listTags, createTag, updateTag, deleteTag };
