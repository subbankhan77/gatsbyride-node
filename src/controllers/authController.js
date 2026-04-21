const bcrypt = require('bcryptjs');
const { Customer, Driver, VehicleCategory } = require('../models');
const { generateToken, apiResponse } = require('../utils/helpers');
const { ORDER_STATUS } = require('../config/constants');

exports.customerLogin = async (req, res) => {
  try {
    const { email, password, fcm_token, device_type, login_type, social_id, first_name, last_name, country } = req.body;

    let customer;

    if (login_type === 'app') {
      customer = await Customer.findOne({ where: { email } });
      if (!customer) return apiResponse(res, 422, false, 'Account does not exist!');

      const valid = await bcrypt.compare(password, customer.password);
      if (!valid) return apiResponse(res, 422, false, 'Invalid password');

      if (customer.status === 0) return apiResponse(res, 200, true, 'Account suspended');

      const token = generateToken({ id: customer.id, guard: 'customer' });
      await customer.update({ api_token: token, fcm_token, device_type });

      return apiResponse(res, 200, true, 'Login successfully', { token, user: customer });
    } else {
      // Google / Apple social login
      customer = await Customer.findOne({ where: { social_id, login_type } });

      if (customer) {
        if (customer.status === 0) return apiResponse(res, 200, true, 'Account suspended');

        const token = generateToken({ id: customer.id, guard: 'customer' });
        await customer.update({ api_token: token, fcm_token, device_type });

        return apiResponse(res, 200, true, 'Login successfully', { token, user: customer });
      } else {
        const name = `${first_name || ''} ${last_name || ''}`.trim();
        customer = await Customer.create({
          name,
          first_name: first_name || '',
          last_name: last_name || '',
          email: email || null,
          social_id,
          login_type,
          fcm_token: fcm_token || null,
          device_type: device_type || null,
          country: country || null,
          status: 1,
        });

        const token = generateToken({ id: customer.id, guard: 'customer' });
        await customer.update({ api_token: token });

        return apiResponse(res, 200, true, 'Login successfully', { token, user: customer });
      }
    }
  } catch (err) {
    return apiResponse(res, 500, false, err.message);
  }
};

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

exports.customerLogout = async (req, res) => {
  try {
    await req.user.update({ api_token: null, fcm_token: null });
    return apiResponse(res, 200, true, 'Logged out successfully');
  } catch (err) {
    return apiResponse(res, 500, false, err.message);
  }
};

exports.driverLogout = async (req, res) => {
  try {
    await req.user.update({ api_token: null, fcm_token: null, order_status: 'offline' });
    return apiResponse(res, 200, true, 'Logged out successfully');
  } catch (err) {
    return apiResponse(res, 500, false, err.message);
  }
};

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

exports.updateCustomerFcmToken = async (req, res) => {
  try {
    const { fcm_token, device_type } = req.body;
    await req.user.update({ fcm_token, device_type });
    return apiResponse(res, 200, true, 'FCM token updated');
  } catch (err) {
    return apiResponse(res, 500, false, err.message);
  }
};

exports.updateDriverFcmToken = async (req, res) => {
  try {
    const { fcm_token, device_type } = req.body;
    await req.user.update({ fcm_token, device_type });
    return apiResponse(res, 200, true, 'FCM token updated');
  } catch (err) {
    return apiResponse(res, 500, false, err.message);
  }
};

exports.deleteCustomer = async (req, res) => {
  try {
    await req.user.destroy();
    return apiResponse(res, 200, true, 'Account deleted');
  } catch (err) {
    return apiResponse(res, 500, false, err.message);
  }
};

exports.deleteDriver = async (req, res) => {
  try {
    await req.user.destroy();
    return apiResponse(res, 200, true, 'Account deleted');
  } catch (err) {
    return apiResponse(res, 500, false, err.message);
  }
};

exports.forgotPassword = async (req, res) => {
  try {
    const { email, type } = req.body;
    if (!email) return apiResponse(res, 200, false, 'Email is required');

    const otp = String(Math.floor(1000 + Math.random() * 9000));

    if (type === 'Driver') {
      const user = await Driver.findOne({ where: { email } });
      if (!user) return apiResponse(res, 200, false, 'Email not found');
      await user.update({ otp });
      return apiResponse(res, 200, true, 'Please check your email we have sent code.' + otp);
    } else {
      const user = await Customer.findOne({ where: { email } });
      if (!user) return apiResponse(res, 200, false, 'Email not found');
      await user.update({ otp });
      return apiResponse(res, 200, true, 'Please check your email we have sent code.' + otp);
    }
  } catch (err) {
    return apiResponse(res, 500, false, err.message);
  }
};

exports.verifyOtp = async (req, res) => {
  try {
    const { email, otp, type } = req.body;
    if (!email || !otp) return apiResponse(res, 200, false, 'Email and OTP are required');

    if (type === 'Driver') {
      const user = await Driver.findOne({ where: { email } });
      if (!user) return apiResponse(res, 200, false, 'Email not found');
      if (user.otp != otp) return apiResponse(res, 200, false, 'Please use valid otp');
      return apiResponse(res, 200, true, 'Otp verified successfully');
    } else {
      const user = await Customer.findOne({ where: { email } });
      if (!user) return apiResponse(res, 200, false, 'Email not found');
      if (user.otp != otp) return apiResponse(res, 200, false, 'Please use valid otp');
      return apiResponse(res, 200, true, 'Otp verified successfully');
    }
  } catch (err) {
    return apiResponse(res, 500, false, err.message);
  }
};

exports.driverResetPassword = async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await Driver.findOne({ where: { email } });
    if (!user) return apiResponse(res, 200, false, 'Email not found');
    if (!user.otp) return apiResponse(res, 200, false, 'OTP not verified');
    const hashed = await bcrypt.hash(password, 10);
    await user.update({ password: hashed, otp: null });
    return apiResponse(res, 200, true, 'Password updated successfully');
  } catch (err) {
    return apiResponse(res, 500, false, err.message);
  }
};

exports.customerResetPassword = async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await Customer.findOne({ where: { email } });
    if (!user) return apiResponse(res, 200, false, 'Email not found');
    if (!user.otp) return apiResponse(res, 200, false, 'OTP not verified');
    const hashed = await bcrypt.hash(password, 10);
    await user.update({ password: hashed, otp: null });
    return apiResponse(res, 200, true, 'Password updated successfully');
  } catch (err) {
    return apiResponse(res, 500, false, err.message);
  }
};
