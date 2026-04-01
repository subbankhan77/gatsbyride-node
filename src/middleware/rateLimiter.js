const rateLimit = require('express-rate-limit');

const common = {
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false },
};

// Login — 10 attempts per 15 minutes per IP
const loginLimiter = rateLimit({
  ...common,
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { status: false, message: 'Too many login attempts. Try again after 15 minutes.' },
});

// Register — 100 registrations per hour per IP
const registerLimiter = rateLimit({
  ...common,
  windowMs: 60 * 60 * 1000,
  max: 100,
  message: { status: false, message: 'Too many registrations from this IP. Try again after 1 hour.' },
});

// File upload — 20 uploads per hour per IP
const uploadLimiter = rateLimit({
  ...common,
  windowMs: 60 * 60 * 1000,
  max: 20,
  message: { status: false, message: 'Upload limit reached. Try again after 1 hour.' },
});

// General API — 200 requests per minute per IP
const apiLimiter = rateLimit({
  ...common,
  windowMs: 60 * 1000,
  max: 200,
  message: { status: false, message: 'Too many requests. Please slow down.' },
});

module.exports = { loginLimiter, registerLimiter, uploadLimiter, apiLimiter };
