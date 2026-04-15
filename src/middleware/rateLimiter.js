const rateLimit = require('express-rate-limit');

const common = {
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false },
};

const loginLimiter = rateLimit({
  ...common,
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { status: false, message: 'Too many login attempts. Try again after 15 minutes.' },
});

const registerLimiter = rateLimit({
  ...common,
  windowMs: 60 * 60 * 1000,
  max: 100,
  message: { status: false, message: 'Too many registrations from this IP. Try again after 1 hour.' },
});

const uploadLimiter = rateLimit({
  ...common,
  windowMs: 60 * 60 * 1000,
  max: 20,
  message: { status: false, message: 'Upload limit reached. Try again after 1 hour.' },
});

const apiLimiter = rateLimit({
  ...common,
  windowMs: 60 * 1000,
  max: 200,
  message: { status: false, message: 'Too many requests. Please slow down.' },
});

module.exports = { loginLimiter, registerLimiter, uploadLimiter, apiLimiter };
