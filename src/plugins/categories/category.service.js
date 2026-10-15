const mongoose = require('mongoose');
const Category = require('./category.model');
const Transaction = require('../transactions/transaction.model');
const AppError = require('../../core/AppError');
const { buildTree, slugify } = require('./category.helper');

// Names are unique among siblings: "Other" can exist under Food and under Shopping, but not twice under Food.
async function assertNameAvailable(name, parent, excludeId) {
  const filter = { parent: parent || null, slug: slugify(name) };
  if (excludeId) filter._id = { $ne: excludeId };
  if (await Category.exists(filter)) {
    throw AppError.conflict(`A category named "${name}" already exists here`, 'CATEGORY_EXISTS');
  }
}

// Subcategories are one level deep, so a parent must itself be top-level.
async function getParent(parentId) {
  const parent = await Category.findById(parentId).lean();
  if (!parent) throw AppError.badRequest('Parent category not found', 'INVALID_PARENT');
  if (parent.parent) throw AppError.badRequest('A subcategory cannot have its own subcategories', 'INVALID_PARENT');
  return parent;
}

async function listCategories({ type, view }) {
  const categories = await Category.find(type ? { type } : {}).sort({ name: 1 }).lean();
  return view === 'flat' ? categories : buildTree(categories);
}

// A category plus its subcategories, so filtering by "Food & Drinks" also matches "Food Delivery".
async function getCategoryFamilyIds(id) {
  const children = await Category.find({ parent: id }, { _id: 1 }).lean();
  return [new mongoose.Types.ObjectId(id), ...children.map((c) => c._id)];
}

async function createCategory(data) {
  if (data.parent) {
    const parent = await getParent(data.parent);
    data = { ...data, type: parent.type, color: data.color || parent.color };
  }
  await assertNameAvailable(data.name, data.parent);
  return Category.create(data);
}

async function updateCategory(id, data) {
  const category = await Category.findById(id);
  if (!category) throw AppError.notFound('Category not found');

  const parentId = data.parent !== undefined ? data.parent : category.parent;
  if (parentId) {
    if (String(parentId) === id) throw AppError.badRequest('A category cannot be its own parent', 'INVALID_PARENT');
    if (data.parent && (await Category.exists({ parent: id }))) {
      throw AppError.badRequest('A category with subcategories cannot become a subcategory', 'INVALID_PARENT');
    }
    const parent = await getParent(parentId);
    data = { ...data, type: parent.type };
  }
  if (data.name || data.parent !== undefined) {
    await assertNameAvailable(data.name || category.name, parentId, category._id);
  }

  category.set(data);
  await category.save();

  // Subcategories always follow their parent's type.
  if (!category.parent && data.type) {
    await Category.updateMany({ parent: category._id }, { type: category.type });
  }
  return category;
}

async function deleteCategory(id) {
  const [children, inUse] = await Promise.all([
    Category.countDocuments({ parent: id }),
    Transaction.countDocuments({ category: id }),
  ]);
  if (children > 0) {
    throw AppError.conflict(`Category has ${children} subcategory(s); delete or move them first`, 'CATEGORY_HAS_CHILDREN');
  }
  if (inUse > 0) {
    throw AppError.conflict(`Category is used by ${inUse} transaction(s); reassign them first`, 'CATEGORY_IN_USE');
  }

  const deleted = await Category.findByIdAndDelete(id);
  if (!deleted) throw AppError.notFound('Category not found');
  return deleted;
}

module.exports = { listCategories, getCategoryFamilyIds, createCategory, updateCategory, deleteCategory };
