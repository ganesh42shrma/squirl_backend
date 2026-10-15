// Inserts the default categories (with subcategories) and tags.
// Safe to re-run: existing entries, and any edits you made to them, are left untouched.
const { connectDB, disconnectDB } = require('../config/db');
const logger = require('../core/logger');
const Category = require('../plugins/categories/category.model');
const Tag = require('../plugins/tags/tag.model');
const { slugify } = require('../plugins/categories/category.helper');
const DEFAULT_CATEGORIES = require('./data/categories');
const DEFAULT_TAGS = require('./data/tags');

// Inserts the category if missing and returns it either way.
function upsertCategory(parent, data) {
  return Category.findOneAndUpdate(
    { parent, slug: slugify(data.name) },
    { $setOnInsert: { ...data, parent, slug: slugify(data.name) } },
    { upsert: true, new: true },
  );
}

async function seedCategories() {
  const before = await Category.countDocuments();

  for (const { children = [], ...data } of DEFAULT_CATEGORIES) {
    const parent = await upsertCategory(null, data);
    for (const name of children) {
      await upsertCategory(parent._id, { name, type: parent.type, color: parent.color });
    }
  }

  return (await Category.countDocuments()) - before;
}

async function seedTags() {
  const ops = DEFAULT_TAGS.flatMap(({ group, color, tags }) =>
    tags.map((name) => ({
      updateOne: { filter: { name }, update: { $setOnInsert: { name, group, color } }, upsert: true },
    })),
  );
  const result = await Tag.bulkWrite(ops);
  return result.upsertedCount;
}

async function seed() {
  await connectDB();
  const categoriesAdded = await seedCategories();
  const tagsAdded = await seedTags();
  logger.info(`Seed complete: ${categoriesAdded} categories and ${tagsAdded} tags added`);
  await disconnectDB();
}

seed().catch(async (err) => {
  logger.error('Seeding failed', { error: err.stack });
  await disconnectDB().catch(() => {});
  process.exit(1);
});
