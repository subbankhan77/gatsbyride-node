const { body, validationResult } = require('express-validator');

const handleValidation = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({
      status: false,
      message: errors.array()[0].msg, 
      errors: errors.array(),
    });
  }
  next();
};

const validateCustomerRegister = [
  body('email').isEmail().withMessage('Valid email required').normalizeEmail(),
  body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
  body('name').notEmpty().withMessage('Name is required').trim(),
  body('phone').optional().isMobilePhone().withMessage('Invalid phone number'),
  handleValidation,
];

const validateDriverRegister = [
  body('email').isEmail().withMessage('Valid email required').normalizeEmail(),
  body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
  body('name').notEmpty().withMessage('Name is required').trim(),
  body('phone').optional().isMobilePhone().withMessage('Invalid phone number'),
  handleValidation,
];

const validateLogin = [
  body('email').isEmail().withMessage('Valid email required').normalizeEmail(),
  body('password').notEmpty().withMessage('Password is required'),
  handleValidation,
];

const validateCreateOrder = [
  body('vehicle_category_id').isInt({ min: 1 }).withMessage('Valid vehicle category required'),
  body('start_coordinate')
    .matches(/^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/)
    .withMessage('start_coordinate format: lat,lng'),
  body('end_coordinate')
    .matches(/^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/)
    .withMessage('end_coordinate format: lat,lng'),
  body('distance').isFloat({ min: 0 }).withMessage('Valid distance required'),
  body('payment_method')
    .optional()
    .isIn(['cash', 'card', 'wallet'])
    .withMessage('payment_method must be cash, card, or wallet'),
  handleValidation,
];

const validatePayment = [
  body('order_id').isInt({ min: 1 }).withMessage('Valid order_id required'),
  body('amount').isFloat({ min: 0.5 }).withMessage('Valid amount required (min 0.5)'),
  body('payment_method_id').notEmpty().withMessage('payment_method_id required'),
  handleValidation,
];

const validateAcceptOrder = [
  body('order_id').isInt({ min: 1 }).withMessage('Valid order_id required'),
  handleValidation,
];

const validateUpdatePassword = [
  body('current_password').notEmpty().withMessage('Current password required'),
  body('new_password').isLength({ min: 6 }).withMessage('New password must be at least 6 characters'),
  handleValidation,
];

module.exports = {
  validateCustomerRegister,
  validateDriverRegister,
  validateLogin,
  validateCreateOrder,
  validatePayment,
  validateAcceptOrder,
  validateUpdatePassword,
};
