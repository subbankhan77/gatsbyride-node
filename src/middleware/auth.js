const jwt = require('jsonwebtoken');
const { Customer, Driver } = require('../models');

// Generic JWT verify middleware - specify guard: 'customer' or 'driver'
const verifyToken = (guard) => async (req, res, next) => {
  try {
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ status: false, message: 'Token not provided' });
    }

    const token = authHeader.split(' ')[1];
    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (err) {
      return res.status(401).json({ status: false, message: 'Invalid or expired token' });
    }

    let user;
    if (guard === 'customer') {
      user = await Customer.findByPk(decoded.id);
    } else if (guard === 'driver') {
      user = await Driver.findByPk(decoded.id);
    }

    if (!user) {
      return res.status(401).json({ status: false, message: 'User not found' });
    }

    // Validate token matches DB (same as Laravel JWT middleware)
    if (user.api_token && user.api_token !== token) {
      return res.status(422).json({ status: false, message: 'Token mismatch' });
    }

    req.user = user;
    req.guard = guard;
    next();
  } catch (err) {
    return res.status(500).json({ status: false, message: 'Auth error', error: err.message });
  }
};

// Check if account is active (not suspended)
const checkActiveStatus = (req, res, next) => {
  if (!req.user || req.user.status === 0) {
    return res.status(403).json({ status: false, message: 'Your account is suspended' });
  }
  next();
};

// Auth for admin (web)
const verifyAdmin = async (req, res, next) => {
  try {
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ status: false, message: 'Token not provided' });
    }
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.admin = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ status: false, message: 'Invalid or expired admin token' });
  }
};

module.exports = { verifyToken, checkActiveStatus, verifyAdmin };
