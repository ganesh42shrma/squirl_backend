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

module.exports = { uploadPdf, uploadImage };
