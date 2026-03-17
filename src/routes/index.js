const express = require('express');
const router = express.Router();
const { verifyToken, checkActiveStatus } = require('../middleware/auth');
const upload = require('../utils/upload');
const { loginLimiter, registerLimiter, uploadLimiter, apiLimiter } = require('../middleware/rateLimiter');
const {
  validateCustomerRegister,
  validateDriverRegister,
  validateLogin,
  validateCreateOrder,
  validatePayment,
  validateAcceptOrder,
} = require('../middleware/validate');

const authController = require('../controllers/authController');
const profileController = require('../controllers/profileController');
const orderController = require('../controllers/orderController');
const paymentController = require('../controllers/paymentController');

const customerAuth = [verifyToken('customer'), checkActiveStatus];
const driverAuth = [verifyToken('driver'), checkActiveStatus];
const driverOnboard = [verifyToken('driver')]; // No active check during onboarding

// General rate limit — sabhi routes pe
router.use(apiLimiter);

// ─────────────────────────────────────────────────────────────────────────────
//  PUBLIC ROUTES
// ─────────────────────────────────────────────────────────────────────────────

// Auth — rate limited
router.post('/login',          loginLimiter,    validateLogin,              authController.customerLogin);
router.post('/logindriver',    loginLimiter,    validateLogin,              authController.driverLogin);
router.post('/user_register',  registerLimiter, validateCustomerRegister,   authController.customerRegister);
router.post('/driver_register',registerLimiter, validateDriverRegister,     authController.driverRegister);

// Public data
router.get('/vehicle/categories',         authController.vehicleCategories);
router.get('/order/reject/reason/list',   orderController.rejectReasonList);
router.post('/rating/list',               orderController.getRatingList);
router.get('/total-price-order',          orderController.getTotalPrice);
router.post('/priceCategory',             orderController.priceCategory);
router.get('/getAllDriverLocation',        orderController.getAllDriverLocations);
router.get('/distance/:pickup',           orderController.getDrivingDistanceRoute);

// File uploads — auth required + rate limited
router.post('/upload',
  driverOnboard,
  uploadLimiter,
  upload.single('file'),
  (req, res) => {
    if (!req.file) return res.status(400).json({ status: false, message: 'No file uploaded' });
    res.json({ status: true, message: 'File uploaded', filename: req.file.filename });
  }
);
router.post('/customerUpload',
  customerAuth,
  uploadLimiter,
  upload.single('file'),
  (req, res) => {
    if (!req.file) return res.status(400).json({ status: false, message: 'No file uploaded' });
    res.json({ status: true, message: 'File uploaded', filename: req.file.filename });
  }
);

// ─────────────────────────────────────────────────────────────────────────────
//  CUSTOMER ROUTES (Authenticated)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/user_profile',        customerAuth,                                       profileController.getCustomerProfile);
router.post('/edit_profile_user',  customerAuth, upload.single('image'),               profileController.updateCustomerProfile);
router.post('/update-email-user',  customerAuth,                                       profileController.updateCustomerEmail);
router.post('/update-password-user',customerAuth,                                      profileController.updateCustomerPassword);

router.post('/send_order',         customerAuth, validateCreateOrder,                  orderController.createOrder);
router.post('/updateStatus',       customerAuth,                                       orderController.updateOrderStatus);
router.get('/history_order_user',  customerAuth,                                       orderController.customerOrderHistory);
router.get('/order',               customerAuth,                                       orderController.getCustomerOrders);
router.get('/order-status-user/:id', customerAuth,                                     orderController.checkOrderStatusByUser);

router.get('/driver_location',     customerAuth,                                       orderController.getDriverLocation);
router.get('/price-check',         customerAuth,                                       orderController.getTotalPrice);

router.post('/card/detail/add',    customerAuth,                                       paymentController.addCard);
router.post('/card/list',          customerAuth,                                       paymentController.listCards);
router.post('/card/delete',        customerAuth,                                       paymentController.deleteCard);
router.post('/driver/payment',     customerAuth, validatePayment,                      paymentController.chargePayment);

router.post('/update/fcm/token',   customerAuth,                                       authController.updateCustomerFcmToken);
router.get('/logout',              customerAuth,                                       authController.customerLogout);
router.delete('/customer/account/delete', customerAuth,                                authController.deleteCustomer);

// ─────────────────────────────────────────────────────────────────────────────
//  DRIVER ONBOARDING (JWT only, no active check)
// ─────────────────────────────────────────────────────────────────────────────
router.post('/driver/profile/details/add', driverOnboard, upload.fields([
  { name: 'profile_photo', maxCount: 1 },
  { name: 'id_proof', maxCount: 1 },
]), profileController.addDriverProfileDetails);

router.post('/driver/vehicle/details/add', driverOnboard, upload.fields([
  { name: 'driving_licence', maxCount: 1 },
  { name: 'driving_licence_back', maxCount: 1 },
]), profileController.addDriverVehicleDetails);

router.post('/driver/bank/details/add', driverOnboard, profileController.addDriverBankDetails);

// ─────────────────────────────────────────────────────────────────────────────
//  DRIVER ROUTES (Authenticated + Active)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/driver/profile',          driverAuth,                                 profileController.getDriverProfile);
router.post('/driver/update-profile',  driverAuth, upload.single('image'),         profileController.updateDriverProfile);
router.post('/driver/update-coordinate', driverAuth,                               profileController.updateDriverCoordinate);
router.post('/driver/update-email',    driverAuth,                                 profileController.updateDriverEmail);
router.post('/driver/update-password', driverAuth,                                 profileController.updateDriverPassword);

router.get('/driver/list-order',       driverAuth,                                 orderController.driverListOrders);
router.get('/driver/order-status',     driverAuth,                                 orderController.driverGetOrderStatus);
router.get('/driver/order',            driverAuth,                                 orderController.driverOrderHistory);
router.post('/driver/update-status',   driverAuth,                                 orderController.driverUpdateOrderStatus);
router.post('/driver/order/reject',    driverAuth,                                 orderController.driverRejectOrder);
router.post('/driver/requests/new',    driverAuth,                                 orderController.driverNewRequests);
router.post('/driver/accept-order',    driverAuth, validateAcceptOrder,            orderController.driverAcceptOrder);
router.post('/driver/update/end/trip', driverAuth,                                 orderController.updateEndTrip);

router.post('/driver/set-status',      driverAuth,                                 profileController.setDriverStatus);
router.get('/driver/get-status',       driverAuth,                                 profileController.getDriverStatus);

router.post('/driver/payment/confirmation', driverAuth,                            paymentController.paymentConfirmation);
router.post('/driver/update/fcm/token',     driverAuth,                            authController.updateDriverFcmToken);
router.get('/driver/logout',                driverAuth,                            authController.driverLogout);
router.delete('/driver/account/delete',     driverAuth,                            authController.deleteDriver);

// ─────────────────────────────────────────────────────────────────────────────
//  ROUTE POLYLINE & SURGE
// ─────────────────────────────────────────────────────────────────────────────
router.get('/order/route/:order_id', orderController.getOrderRoute);
router.get('/surge/check',           orderController.getSurgeInfo);

// ─────────────────────────────────────────────────────────────────────────────
//  SHARED RATING ROUTES
// ─────────────────────────────────────────────────────────────────────────────
router.post('/order/rating',        verifyToken('customer'), orderController.submitRating);
router.post('/driver/order/rating', verifyToken('driver'),   orderController.submitRating);

module.exports = router;
