const mongoose = require('mongoose');
const { slugify } = require('./category.helper');

/**
 * expense    – money spent (food, rent, shopping…)
 * income     – money earned (salary, freelancing, cashback…)
 * investment – money put to work (SIPs, stocks, FDs…)
 * transfer   – moving your own money (credit card bill, account to account, ATM) – not spending
 * lending    – money lent to or borrowed from people, split settlements
 */
const CATEGORY_TYPES = ['expense', 'income', 'investment', 'transfer', 'lending'];

const categorySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 50 },
    slug: { type: String, required: true, lowercase: true },
    type: { type: String, enum: CATEGORY_TYPES, default: 'expense' },
    // null for a top-level category; set for a subcategory (only one level deep).
    parent: { type: mongoose.Schema.Types.ObjectId, ref: 'Category', default: null },
    color: { type: String, default: '#9ca3af' },
    icon: { type: String },
  },
  { timestamps: true },
);

// The same name can exist under different parents ("Other" under Food and under Shopping).
categorySchema.index({ parent: 1, slug: 1 }, { unique: true });

categorySchema.pre('validate', function setSlug() {
  if (this.isModified('name')) this.slug = slugify(this.name);
});

module.exports = mongoose.model('Category', categorySchema);
module.exports.CATEGORY_TYPES = CATEGORY_TYPES;
