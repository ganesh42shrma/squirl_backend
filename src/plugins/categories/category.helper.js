// "Food & Drinks" → "food-and-drinks"
function slugify(name) {
  return String(name)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

// Flat list → top-level categories, each with a `children` array of its subcategories.
function buildTree(categories) {
  const childrenByParent = new Map();
  for (const category of categories) {
    if (!category.parent) continue;
    const key = String(category.parent);
    if (!childrenByParent.has(key)) childrenByParent.set(key, []);
    childrenByParent.get(key).push(category);
  }

  return categories
    .filter((category) => !category.parent)
    .map((category) => ({ ...category, children: childrenByParent.get(String(category._id)) || [] }));
}

module.exports = { slugify, buildTree };
