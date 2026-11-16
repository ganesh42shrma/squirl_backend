const multer = require('multer');
const AppError = require('./AppError');
const config = require('../config');

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

const uploadPdf = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE, files: 1 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype !== 'application/pdf') {
      return cb(AppError.badRequest('Only PDF files are allowed', 'INVALID_FILE_TYPE'));
    }
    cb(null, true);
  },
});

// Photo attachments, kept in memory (they are encrypted before touching disk). The limit is read per request
// from config.media.maxBytes. Only the size is checked here; whether the bytes really are an image is decided
// by their header in the media service, never by the client's Content-Type or file name.
const imageParsers = new Map();
function imageParser(maxBytes) {
  if (!imageParsers.has(maxBytes)) {
    imageParsers.set(maxBytes, multer({
      storage: multer.memoryStorage(),
      limits: { fileSize: maxBytes, files: 1, fields: 4, parts: 6 },
    }).single('file'));
  }
  return imageParsers.get(maxBytes);
}

function uploadImage(req, res, next) {
  const maxBytes = config.media.maxBytes;
  imageParser(maxBytes)(req, res, (err) => {
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
      return next(new AppError(`That photo is too big. The limit is ${Math.round(maxBytes / (1024 * 1024))} MB.`, 413, 'FILE_TOO_LARGE'));
    }
    next(err);
  });
}

// A phone-book export (.vcf), read in memory and never stored. Phones label the file differently (text/vcard,
// text/x-vcard, text/plain, or nothing), so only the size is checked here; the contents are checked by the parser.
const MAX_VCF_BYTES = 20 * 1024 * 1024; // exports that carry contact photos get big
const vcfParser = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_VCF_BYTES, files: 1, fields: 2, parts: 4 } }).single('file');

function uploadVcf(req, res, next) {
  vcfParser(req, res, (err) => {
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
      return next(new AppError(`That file is too big. The limit is ${MAX_VCF_BYTES / (1024 * 1024)} MB.`, 413, 'FILE_TOO_LARGE'));
    }
    next(err);
  });
}

module.exports = { uploadPdf, uploadImage, uploadVcf };
