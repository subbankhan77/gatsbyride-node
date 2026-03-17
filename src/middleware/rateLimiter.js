const rateLimit = require('express-rate-limit');

// Login — 10 attempts per 15 minutes per IP
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { status: false, message: 'Too many login attempts. Try again after 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Register — 5 registrations per hour per IP
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: { status: false, message: 'Too many registrations from this IP. Try again after 1 hour.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// File upload — 20 uploads per hour per IP
const uploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  message: { status: false, message: 'Upload limit reached. Try again after 1 hour.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// General API — 200 requests per minute per IP
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  message: { status: false, message: 'Too many requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
});

module.exports = { loginLimiter, registerLimiter, uploadLimiter, apiLimiter };
