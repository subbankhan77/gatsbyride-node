const jwt = require('jsonwebtoken');
const { AdminUser } = require('../models');

const verifyAdmin = async (req, res, next) => {
  try {
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ status: false, message: 'Admin token not provided' });
    }

    const token = authHeader.split(' ')[1];
    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (err) {
      return res.status(401).json({ status: false, message: 'Invalid or expired admin token' });
    }

    if (decoded.role !== 'admin') {
      return res.status(403).json({ status: false, message: 'Access denied' });
    }

    const admin = await AdminUser.findByPk(decoded.id, {
      attributes: { exclude: ['password'] },
    });
    if (!admin) return res.status(401).json({ status: false, message: 'Admin not found' });
    if (admin.status === 0) return res.status(403).json({ status: false, message: 'Admin account suspended' });

    if (admin.remember_token && admin.remember_token !== token) {
      return res.status(401).json({ status: false, message: 'Invalid or expired admin token' });
    }

    req.admin = admin;
    next();
  } catch (err) {
    return res.status(500).json({ status: false, message: err.message });
  }
};

module.exports = verifyAdmin;
