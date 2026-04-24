const multer = require('multer');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, path.join(__dirname, '../../uploads'));
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, uuidv4() + ext);
  },
});

const fileFilter = (req, file, cb) => {
  const allowedMime = /^image\//;
  const allowedExt = /jpeg|jpg|png|gif|pdf|webp|bmp|tiff|tif|svg|heic|heif/;
  const mimeOk = allowedMime.test(file.mimetype);
  const extOk = allowedExt.test(path.extname(file.originalname).toLowerCase());
  if (mimeOk || extOk) {
    cb(null, true);
  } else {
    cb(new Error('Only images and PDF files are allowed'));
  }
};

const upload = multer({ storage, fileFilter, limits: { fileSize: 10 * 1024 * 1024 } });

module.exports = upload;
