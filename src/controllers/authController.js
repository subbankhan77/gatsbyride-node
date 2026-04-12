const bcrypt = require('bcryptjs');
const { Customer, Driver, VehicleCategory } = require('../models');
const { generateToken, apiResponse } = require('../utils/helpers');
const { ORDER_STATUS } = require('../config/constants');

// ─── Customer Login ───────────────────────────────────────────────────────────
exports.customerLogin = async (req, res) => {
  try {
    const { email, password, fcm_token, device_type, login_type, social_id } = req.body;

    let customer;
    if (login_type === 'social' && social_id) {
      customer = await Customer.findOne({ where: { social_id } });
      if (!customer) {
        // Auto register social user
        customer = await Customer.create({
          name: req.body.name || '',
          email: email || null,
          social_id,
          login_type: 'social',
          status: 1,
        });
      }
    } else {
      customer = await Customer.findOne({ where: { email } });
      if (!customer) {
        return apiResponse(res, 422, false, 'Email not found');
      }
      const valid = await bcrypt.compare(password, customer.password);
      if (!valid) {
        return apiResponse(res, 422, false, 'Invalid password');
      }
    }

    if (customer.status === 0) {
      return apiResponse(res, 403, false, 'Your account is suspended');
    }

    const token = generateToken({ id: customer.id, guard: 'customer' });
    await customer.update({ api_token: token, fcm_token, device_type });

    return apiResponse(res, 200, true, 'Login successful', { token, user: customer });
  } catch (err) {
    return apiResponse(res, 500, false, err.message);
  }
};

// ─── Driver Login ─────────────────────────────────────────────────────────────
exports.driverLogin = async (req, res) => {
  try {
    const { email, password, fcm_token, device_type } = req.body;
    console.log("Driver Login Body =>",req.body);
    
    const driver = await Driver.findOne({ where: { email } });
    if (!driver) return apiResponse(res, 422, false, 'Email not found');

    const valid = await bcrypt.compare(password, driver.password);
    if (!valid) return apiResponse(res, 422, false, 'Invalid password');

    if (driver.status === 0) return apiResponse(res, 403, false, 'Your account is suspended');

    if (driver.verification_status !== 1) {
      return apiResponse(res, 403, false, 'Your account is under review. Please wait for admin approval.');
    }

    const token = generateToken({ id: driver.id, guard: 'driver' });
    await driver.update({ api_token: token, fcm_token, device_type });

    return apiResponse(res, 200, true, 'Login successful', { token, user: driver });
  } catch (err) {
    return apiResponse(res, 500, false, err.message);
  }
};

// ─── Customer Register ────────────────────────────────────────────────────────
exports.customerRegister = async (req, res) => {
  try {
    const { name, email, password, phone, country, fcm_token, device_type } = req.body;

    const existing = await Customer.findOne({ where: { email } });
    if (existing) return apiResponse(res, 422, false, 'Email already registered');

    const hashed = await bcrypt.hash(password, 10);
    const customer = await Customer.create({
      name, email, password: hashed, phone, country,
      fcm_token, device_type, status: 1, login_type: 'app',
    });

    const token = generateToken({ id: customer.id, guard: 'customer' });
    await customer.update({ api_token: token });

    return apiResponse(res, 201, true, 'Registration successful', { token, user: customer });
  } catch (err) {
    return apiResponse(res, 500, false, err.message);
  }
};

// ─── Driver Signup (onboarding resume support) ────────────────────────────────
exports.signUpDriver = async (req, res) => {
  try {
    const { email, password, firebase_uid, fcm_token } = req.body;

    if (!email || !password) {
      return apiResponse(res, 200, false, 'The email field is required');
    }
    if (password.length < 6) {
      return apiResponse(res, 200, false, 'Password must be at least 6 characters');
    }

    const existing = await Driver.findOne({ where: { email } });

    if (existing) {
      // Bank details complete → email already taken
      if (existing.bank_status == 1) {
        return apiResponse(res, 200, false, 'Email already registered');
      }
      
      const token = generateToken({ id: existing.id, guard: 'driver' });
      await existing.update({ api_token: token });
      return apiResponse(res, 200, true, 'Your account is under review by admin.', {
        token,
        data: { id: existing.id, email: existing.email },
      });
    }

    const hashed = await bcrypt.hash(password, 10);
    const tokenExpiry = new Date();
    tokenExpiry.setMonth(tokenExpiry.getMonth() + 1);

    const driver = await Driver.create({
      email,
      password: hashed,
      firebase_uid: firebase_uid || '',
      fcm_token: fcm_token || null,
      api_token_expired: tokenExpiry,
      status: 1,
      order_status: 'offline',
      profile_status: 1,
    });

    const token = generateToken({ id: driver.id, guard: 'driver' });
    await driver.update({ api_token: token });

    return apiResponse(res, 200, true, 'Register success', {
      token,
      data: { id: driver.id, email: driver.email },
    });
  } catch (err) {
    return apiResponse(res, 500, false, err.message);
  }
};

// ─── Driver Register ──────────────────────────────────────────────────────────
exports.driverRegister = async (req, res) => {
  try {
    const { name, first_name, last_name, email, password, phone, country, fcm_token, device_type } = req.body;

    const existing = await Driver.findOne({ where: { email } });
    if (existing) return apiResponse(res, 422, false, 'Email already registered');

    const hashed = await bcrypt.hash(password, 10);
    const driver = await Driver.create({
      name, first_name, last_name, email, password: hashed,
      phone, country, fcm_token, device_type, status: 1,
      order_status: 'offline', profile_status: 1,
    });

    const token = generateToken({ id: driver.id, guard: 'driver' });
    await driver.update({ api_token: token });

    return apiResponse(res, 201, true, 'Registration successful', { token, user: driver });
  } catch (err) {
    return apiResponse(res, 500, false, err.message);
  }
};

// ─── Customer Logout ──────────────────────────────────────────────────────────
exports.customerLogout = async (req, res) => {
  try {
    await req.user.update({ api_token: null, fcm_token: null });
    return apiResponse(res, 200, true, 'Logged out successfully');
  } catch (err) {
    return apiResponse(res, 500, false, err.message);
  }
};

// ─── Driver Logout ────────────────────────────────────────────────────────────
exports.driverLogout = async (req, res) => {
  try {
    await req.user.update({ api_token: null, fcm_token: null, order_status: 'offline' });
    return apiResponse(res, 200, true, 'Logged out successfully');
  } catch (err) {
    return apiResponse(res, 500, false, err.message);
  }
};

// ─── Get Vehicle Categories ───────────────────────────────────────────────────
exports.vehicleCategories = async (req, res) => {
  try {
    const categories = await VehicleCategory.findAll({
      where:{status:1}
    });
    return apiResponse(res, 200, true, 'Vehicle categories', categories);
  } catch (err) {
    return apiResponse(res, 500, false, err.message);
  }
};

// ─── Update Customer FCM Token ────────────────────────────────────────────────
exports.updateCustomerFcmToken = async (req, res) => {
  try {
    const { fcm_token, device_type } = req.body;
    await req.user.update({ fcm_token, device_type });
    return apiResponse(res, 200, true, 'FCM token updated');
  } catch (err) {
    return apiResponse(res, 500, false, err.message);
  }
};

// ─── Update Driver FCM Token ──────────────────────────────────────────────────
exports.updateDriverFcmToken = async (req, res) => {
  try {
    const { fcm_token, device_type } = req.body;
    await req.user.update({ fcm_token, device_type });
    return apiResponse(res, 200, true, 'FCM token updated');
  } catch (err) {
    return apiResponse(res, 500, false, err.message);
  }
};

// ─── Delete Customer Account ──────────────────────────────────────────────────
exports.deleteCustomer = async (req, res) => {
  try {
    await req.user.destroy();
    return apiResponse(res, 200, true, 'Account deleted');
  } catch (err) {
    return apiResponse(res, 500, false, err.message);
  }
};

// ─── Delete Driver Account ────────────────────────────────────────────────────
exports.deleteDriver = async (req, res) => {
  try {
    await req.user.destroy();
    return apiResponse(res, 200, true, 'Account deleted');
  } catch (err) {
    return apiResponse(res, 500, false, err.message);
  }
};
