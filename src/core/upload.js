const multer = require('multer');
const AppError = require('./AppError');

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

module.exports = { uploadPdf };
