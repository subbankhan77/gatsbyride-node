const express = require('express');
const router = express.Router();
const verifyAdmin = require('../middleware/adminAuth');
const upload = require('../utils/upload');
const admin = require('../controllers/adminController');
const { loginLimiter, apiLimiter } = require('../middleware/rateLimiter');

router.post('/login', loginLimiter, admin.login);

router.use(verifyAdmin);
router.use(apiLimiter);

router.post('/logout', admin.logout);
router.get('/dashboard', admin.dashboard);

router.get('/customers', admin.getCustomers);
router.get('/customers/:id', admin.getCustomer);
router.put('/customers/:id', admin.updateCustomer);
router.delete('/customers/:id', admin.deleteCustomer);
router.post('/customers/:id/toggle-status', admin.toggleCustomerStatus);

router.get('/drivers', admin.getDrivers);
router.get('/drivers/online', admin.getOnlineDrivers);
router.get('/drivers/:id', admin.getDriver);
router.put('/drivers/:id', admin.updateDriver);
router.delete('/drivers/:id', admin.deleteDriver);
router.post('/drivers/:id/toggle-status', admin.toggleDriverStatus);
router.post('/drivers/:id/toggle-verification', admin.toggleDriverVerification);

router.get('/orders', admin.getOrders);
router.get('/orders/:id', admin.getOrder);

router.get('/vehicle-categories', admin.getVehicleCategories);
router.post('/vehicle-categories', upload.single('image'), admin.createVehicleCategory);
router.put('/vehicle-categories/:id', upload.single('image'), admin.updateVehicleCategory);
router.delete('/vehicle-categories/:id', admin.deleteVehicleCategory);

router.get('/admins', admin.getAdmins);
router.post('/admins', admin.createAdmin);
router.put('/admins/:id', admin.updateAdmin);
router.delete('/admins/:id', admin.deleteAdmin);

router.get('/reasons', admin.getReasons);
router.post('/reasons', admin.createReason);
router.put('/reasons/:id', admin.updateReason);
router.delete('/reasons/:id', admin.deleteReason);

router.get('/about-us', admin.getAboutUs);
router.put('/about-us', admin.updateAboutUs);

router.get('/settings', admin.getSettings);
router.put('/settings', admin.updateSettings);

module.exports = router;
