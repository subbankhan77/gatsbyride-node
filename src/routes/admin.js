const express = require('express');
const router = express.Router();
const verifyAdmin = require('../middleware/adminAuth');
const upload = require('../utils/upload');
const admin = require('../controllers/adminController');
const { loginLimiter } = require('../middleware/rateLimiter');

// ─── Public ───────────────────────────────────────────────────────────────────
router.post('/login', loginLimiter, admin.login);

// ─── All routes below require admin JWT ──────────────────────────────────────
router.use(verifyAdmin);

// Dashboard
router.get('/dashboard', admin.dashboard);

// Customers
router.get('/customers', admin.getCustomers);
router.get('/customers/:id', admin.getCustomer);
router.put('/customers/:id', admin.updateCustomer);
router.delete('/customers/:id', admin.deleteCustomer);
router.post('/customers/:id/toggle-status', admin.toggleCustomerStatus);

// Drivers
router.get('/drivers', admin.getDrivers);
router.get('/drivers/online', admin.getOnlineDrivers);
router.get('/drivers/:id', admin.getDriver);
router.put('/drivers/:id', admin.updateDriver);
router.delete('/drivers/:id', admin.deleteDriver);
router.post('/drivers/:id/toggle-status', admin.toggleDriverStatus);
router.post('/drivers/:id/toggle-verification', admin.toggleDriverVerification);

// Orders
router.get('/orders', admin.getOrders);
router.get('/orders/:id', admin.getOrder);

// Vehicle Categories
router.get('/vehicle-categories', admin.getVehicleCategories);
router.post('/vehicle-categories', upload.single('image'), admin.createVehicleCategory);
router.put('/vehicle-categories/:id', upload.single('image'), admin.updateVehicleCategory);
router.delete('/vehicle-categories/:id', admin.deleteVehicleCategory);

// Admin Users
router.get('/admins', admin.getAdmins);
router.post('/admins', admin.createAdmin);
router.put('/admins/:id', admin.updateAdmin);
router.delete('/admins/:id', admin.deleteAdmin);

// Cancellation Reasons
router.get('/reasons', admin.getReasons);
router.post('/reasons', admin.createReason);
router.put('/reasons/:id', admin.updateReason);
router.delete('/reasons/:id', admin.deleteReason);

// About Us
router.get('/about-us', admin.getAboutUs);
router.put('/about-us', admin.updateAboutUs);

// Settings
router.get('/settings', admin.getSettings);
router.put('/settings', admin.updateSettings);

module.exports = router;
