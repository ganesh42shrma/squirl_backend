const mongoose = require('mongoose');

const BANKS = ['sbi', 'kotak'];
const IMPORT_STATUSES = ['processing', 'completed', 'failed'];

const importBatchSchema = new mongoose.Schema(
  {
    bank: { type: String, enum: BANKS, required: true },
    fileName: { type: String, required: true },
    status: { type: String, enum: IMPORT_STATUSES, default: 'processing' },
    stats: {
      parsed: { type: Number, default: 0 },
      inserted: { type: Number, default: 0 },
      duplicates: { type: Number, default: 0 },
      skipped: { type: Number, default: 0 },
    },
    periodFrom: { type: Date },
    periodTo: { type: Date },
    error: { type: String },
  },
  { timestamps: true },
);

importBatchSchema.index({ createdAt: -1 });

module.exports = mongoose.model('ImportBatch', importBatchSchema);
module.exports.BANKS = BANKS;
