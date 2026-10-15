const mongoose = require('mongoose');

const CUSTOM_GROUP = 'custom';

// The tag catalog. Transactions store tag names as plain strings; this adds a group and color to each name.
const tagSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true, trim: true, lowercase: true, maxlength: 40 },
    group: { type: String, trim: true, lowercase: true, default: CUSTOM_GROUP },
    color: { type: String, default: '#9ca3af' },
  },
  { timestamps: true },
);

tagSchema.index({ group: 1, name: 1 });

module.exports = mongoose.model('Tag', tagSchema);
module.exports.CUSTOM_GROUP = CUSTOM_GROUP;
