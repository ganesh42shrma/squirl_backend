const mongoose = require('mongoose');

const TRANSACTION_TYPES = ['debit', 'credit'];
const SOURCES = ['manual', 'import'];

const transactionSchema = new mongoose.Schema(
  {
    date: { type: Date, required: true },
    description: { type: String, required: true, trim: true, maxlength: 500 },
    amount: {
      type: Number,
      required: true,
      min: 0,
      set: (v) => Math.round(v * 100) / 100,
    },
    type: { type: String, enum: TRANSACTION_TYPES, required: true },
    category: { type: mongoose.Schema.Types.ObjectId, ref: 'Category', default: null },
    tags: { type: [String], default: [] },
    notes: { type: String, trim: true, maxlength: 1000 },
    account: { type: String, trim: true, lowercase: true, default: 'cash' },
    paymentMode: { type: String, trim: true, lowercase: true },
    source: { type: String, enum: SOURCES, default: 'manual' },
    importId: { type: mongoose.Schema.Types.ObjectId, ref: 'ImportBatch' },
    refNo: { type: String, trim: true },
    balance: { type: Number },
    // Fingerprint of an imported row, used to skip duplicates when a statement is re-imported.
    hash: { type: String },
  },
  { timestamps: true },
);

transactionSchema.index({ date: -1 });
transactionSchema.index({ category: 1, date: -1 });
transactionSchema.index({ tags: 1 });
transactionSchema.index({ importId: 1 });
transactionSchema.index({ hash: 1 }, { unique: true, sparse: true });

module.exports = mongoose.model('Transaction', transactionSchema);
module.exports.TRANSACTION_TYPES = TRANSACTION_TYPES;
module.exports.SOURCES = SOURCES;
