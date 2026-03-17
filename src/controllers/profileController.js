const bcrypt = require('bcryptjs');
const { Customer, Driver, BankDetails } = require('../models');
const { apiResponse } = require('../utils/helpers');

// ─── Get Customer Profile ─────────────────────────────────────────────────────
exports.getCustomerProfile = async (req, res) => {
  try {
    return apiResponse(res, 200, true, 'Customer profile', req.user);
  } catch (err) {
    return apiResponse(res, 500, false, err.message);
  }
};

// ─── Update Customer Profile ──────────────────────────────────────────────────
exports.updateCustomerProfile = async (req, res) => {
  try {
    const { name, first_name, last_name, phone, country, latitude, longitude } = req.body;
    const image = req.file ? req.file.filename : undefined;

    const updateData = { name, first_name, last_name, phone, country, latitude, longitude };
    if (image) updateData.image = image;

    await req.user.update(updateData);
    return apiResponse(res, 200, true, 'Profile updated', req.user);
  } catch (err) {
    return apiResponse(res, 500, false, err.message);
  }
};

// ─── Update Customer Email ────────────────────────────────────────────────────
exports.updateCustomerEmail = async (req, res) => {
  try {
    const { email } = req.body;
    const exists = await Customer.findOne({ where: { email } });
    if (exists && exists.id !== req.user.id) {
      return apiResponse(res, 422, false, 'Email already in use');
    }
    await req.user.update({ email });
    return apiResponse(res, 200, true, 'Email updated');
  } catch (err) {
    return apiResponse(res, 500, false, err.message);
  }
};

// ─── Update Customer Password ─────────────────────────────────────────────────
exports.updateCustomerPassword = async (req, res) => {
  try {
    const { current_password, new_password } = req.body;
    const valid = await bcrypt.compare(current_password, req.user.password);
    if (!valid) return apiResponse(res, 422, false, 'Current password is incorrect');

    const hashed = await bcrypt.hash(new_password, 10);
    await req.user.update({ password: hashed });
    return apiResponse(res, 200, true, 'Password updated');
  } catch (err) {
    return apiResponse(res, 500, false, err.message);
  }
};

// ─── Get Driver Profile ───────────────────────────────────────────────────────
exports.getDriverProfile = async (req, res) => {
  try {
    const driver = await Driver.findByPk(req.user.id, {
      include: [{ association: 'VehicleCategory' }],
    });
    return apiResponse(res, 200, true, 'Driver profile', driver);
  } catch (err) {
    return apiResponse(res, 500, false, err.message);
  }
};

// ─── Update Driver Profile ────────────────────────────────────────────────────
exports.updateDriverProfile = async (req, res) => {
  try {
    const {
      name, first_name, last_name, phone, city, state,
      country, address, postal_code,
    } = req.body;

    const image = req.file ? req.file.filename : undefined;
    const updateData = { name, first_name, last_name, phone, city, state, country, address, postal_code };
    if (image) updateData.image = image;

    await req.user.update(updateData);
    return apiResponse(res, 200, true, 'Profile updated', req.user);
  } catch (err) {
    return apiResponse(res, 500, false, err.message);
  }
};

// ─── Update Driver Email ──────────────────────────────────────────────────────
exports.updateDriverEmail = async (req, res) => {
  try {
    const { email } = req.body;
    const exists = await Driver.findOne({ where: { email } });
    if (exists && exists.id !== req.user.id) {
      return apiResponse(res, 422, false, 'Email already in use');
    }
    await req.user.update({ email });
    return apiResponse(res, 200, true, 'Email updated');
  } catch (err) {
    return apiResponse(res, 500, false, err.message);
  }
};

// ─── Update Driver Password ───────────────────────────────────────────────────
exports.updateDriverPassword = async (req, res) => {
  try {
    const { current_password, new_password } = req.body;
    const valid = await bcrypt.compare(current_password, req.user.password);
    if (!valid) return apiResponse(res, 422, false, 'Current password is incorrect');

    const hashed = await bcrypt.hash(new_password, 10);
    await req.user.update({ password: hashed });
    return apiResponse(res, 200, true, 'Password updated');
  } catch (err) {
    return apiResponse(res, 500, false, err.message);
  }
};

// ─── Update Driver Location ───────────────────────────────────────────────────
exports.updateDriverCoordinate = async (req, res) => {
  try {
    const { latitude, longitude, bearing } = req.body;
    await req.user.update({
      Latitude: latitude,
      Longitude: longitude,
      bearing,
      position: `${latitude},${longitude}`,
    });

    // Emit location to Socket.io (if socket instance attached to req)
    if (req.io) {
      req.io.emit('driver_location_update', {
        driver_id: req.user.id,
        latitude,
        longitude,
        bearing,
      });
    }

    return apiResponse(res, 200, true, 'Location updated');
  } catch (err) {
    return apiResponse(res, 500, false, err.message);
  }
};

// ─── Add Driver Profile Details ───────────────────────────────────────────────
exports.addDriverProfileDetails = async (req, res) => {
  try {
    const { city, state, country, address, postal_code, dob, id_number } = req.body;
    const files = req.files || {};
    const updateData = { city, state, country, address, postal_code, dob, id_number, profile_status: 'step2' };

    if (files.profile_photo) updateData.profile_photo = files.profile_photo[0].filename;
    if (files.id_proof) updateData.id_proof = files.id_proof[0].filename;

    await req.user.update(updateData);
    return apiResponse(res, 200, true, 'Profile details added', req.user);
  } catch (err) {
    return apiResponse(res, 500, false, err.message);
  }
};

// ─── Add Driver Vehicle Details ───────────────────────────────────────────────
exports.addDriverVehicleDetails = async (req, res) => {
  try {
    const { vehicle_category_id, plate_number, vehicle_name, car_model, insurance_number } = req.body;
    const files = req.files || {};

    const updateData = {
      vehicle_category_id, plate_number, vehicle_name, car_model, insurance_number,
      profile_status: 'step3',
    };

    if (files.driving_licence) updateData.driving_licence = files.driving_licence[0].filename;
    if (files.driving_licence_back) updateData.driving_licence_back = files.driving_licence_back[0].filename;

    await req.user.update(updateData);
    return apiResponse(res, 200, true, 'Vehicle details added', req.user);
  } catch (err) {
    return apiResponse(res, 500, false, err.message);
  }
};

// ─── Add Driver Bank Details ──────────────────────────────────────────────────
exports.addDriverBankDetails = async (req, res) => {
  try {
    const { account_holder_name, bank_name, account_number, transit_number, institution_number } = req.body;

    const bank = await BankDetails.create({
      driver_id: req.user.id,
      account_holder_name, bank_name, account_number,
      transit_number, institution_number, status: 1,
    });

    await req.user.update({ bank_status: 1, profile_status: 'complete' });
    return apiResponse(res, 201, true, 'Bank details added', bank);
  } catch (err) {
    return apiResponse(res, 500, false, err.message);
  }
};

// ─── Set Driver Status (online/offline) ───────────────────────────────────────
exports.setDriverStatus = async (req, res) => {
  try {
    const { status } = req.body; // 'online' or 'offline'
    await req.user.update({ order_status: status });

    if (req.io) {
      req.io.emit('driver_status_change', { driver_id: req.user.id, status });
    }

    return apiResponse(res, 200, true, 'Status updated', { status });
  } catch (err) {
    return apiResponse(res, 500, false, err.message);
  }
};

// ─── Get Driver Status ────────────────────────────────────────────────────────
exports.getDriverStatus = async (req, res) => {
  try {
    return apiResponse(res, 200, true, 'Driver status', {
      status: req.user.order_status,
      is_available: req.user.is_available,
    });
  } catch (err) {
    return apiResponse(res, 500, false, err.message);
  }
};
