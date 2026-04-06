const bcrypt = require('bcryptjs');
const { Customer, Driver, BankDetails } = require('../models');
const { apiResponse } = require('../utils/helpers');
const { driverOnline, driverOffline } = require('../utils/driverLocation');

exports.getCustomerProfile = async (req, res) => {
  try {
    return apiResponse(res, 200, true, 'Customer profile', req.user);
  } catch (err) {
    return apiResponse(res, 500, false, err.message);
  }
};

exports.customerCreateProfile = async (req, res) => {
  try {
    const { first_name, last_name, phone, country, latitude, longitude, image } = req.body;
    const updateData = { first_name, last_name, phone, country, latitude, longitude };
    if (first_name || last_name) {
      updateData.name = `${first_name || ''} ${last_name || ''}`.trim();
    }
    if (image) updateData.image = image;
    await req.user.update(updateData);
    return apiResponse(res, 200, true, 'Profile updated successfully', req.user);
  } catch (err) {
    return apiResponse(res, 500, false, err.message);
  }
};

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

exports.updateDriverProfile = async (req, res) => {
  try {
    const { name, first_name, last_name, phone, city, state, country, address, postal_code } = req.body;
    const image = req.file ? req.file.filename : undefined;
    const updateData = { name, first_name, last_name, phone, city, state, country, address, postal_code };
    if (image) updateData.image = image;
    await req.user.update(updateData);
    return apiResponse(res, 200, true, 'Profile updated', req.user);
  } catch (err) {
    return apiResponse(res, 500, false, err.message);
  }
};

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

exports.updateDriverCoordinate = async (req, res) => {
  try {
    const { bearing } = req.body;
    const latitude = parseFloat(req.body.latitude);
    const longitude = parseFloat(req.body.longitude);

    if (isNaN(latitude) || isNaN(longitude)) {
      return apiResponse(res, 422, false, 'Valid latitude and longitude are required');
    }

    await req.user.update({
      Latitude: latitude,
      Longitude: longitude,
      bearing,
      position: `${latitude},${longitude}`,
    });
    const { updateDriverLocation } = require('../utils/driverLocation');
    await updateDriverLocation(req.user.id, {
      latitude,
      longitude,
      bearing: bearing || 0,
      vehicle_category_id: req.user.vehicle_category_id,
    });
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

exports.addDriverProfileDetails = async (req, res) => {
  try {
    const { city, state, country, address, postal_code, dob, id_number } = req.body;
    const files = req.files || {};
    const updateData = { city, state, country, address, postal_code, dob, id_number, profile_status: 2 };
    if (files.profile_photo) updateData.profile_photo = files.profile_photo[0].filename;
    if (files.id_proof) updateData.id_proof = files.id_proof[0].filename;
    await req.user.update(updateData);
    return apiResponse(res, 200, true, 'Profile details added', req.user);
  } catch (err) {
    return apiResponse(res, 500, false, err.message);
  }
};

exports.addDriverVehicleDetails = async (req, res) => {
  try {
    const { vehicle_category_id, plate_number, vehicle_name, car_model, insurance_number } = req.body;
    const files = req.files || {};
    const updateData = { vehicle_category_id, plate_number, vehicle_name, car_model, insurance_number, profile_status: 3 };
    if (files.driving_licence) updateData.driving_licence = files.driving_licence[0].filename;
    if (files.driving_licence_back) updateData.driving_licence_back = files.driving_licence_back[0].filename;
    await req.user.update(updateData);
    return apiResponse(res, 200, true, 'Vehicle details added', req.user);
  } catch (err) {
    return apiResponse(res, 500, false, err.message);
  }
};

exports.addDriverBankDetails = async (req, res) => {
  try {
    const { account_holder_name, bank_name, account_number, transit_number, institution_number } = req.body;
    const bank = await BankDetails.create({
      driver_id: req.user.id,
      account_holder_name, bank_name, account_number,
      transit_number, institution_number, status: 1,
    });
    await req.user.update({ bank_status: 1, profile_status: 4 });
    return apiResponse(res, 201, true, 'Bank details added', bank);
  } catch (err) {
    return apiResponse(res, 500, false, err.message);
  }
};

exports.setDriverStatus = async (req, res) => {
  try {
    const { status, bearing } = req.body;

    console.log("setDriverStatus setDriverStatussetDriverStatus ==>>>", req.body);
    
    let latitude = req.body.latitude ?? req.body.lat;
    let longitude = req.body.longitude ?? req.body.lng ?? req.body.lon;
    const driverId = req.user.id;

    const isOnline = status === 'online' || status === 1 || status === '1';

    console.log(`Driver ${driverId} set-status: received="${status}" isOnline=${isOnline} lat=${latitude} lng=${longitude}`);

    if (isOnline) {
      // Agar lat/lng app se nahi aaya toh DB ki last known location use karo
      if (!latitude || !longitude) {
        latitude = req.user.Latitude;
        longitude = req.user.Longitude;
        console.log(`Driver ${driverId} — lat/lng missing from app, using DB fallback: lat=${latitude} lng=${longitude}`);
      }

      const lat = parseFloat(latitude);
      const lng = parseFloat(longitude);
      const hasLocation = !isNaN(lat) && !isNaN(lng);

      const updateData = { order_status: 'online' };
      if (hasLocation) {
        updateData.Latitude = lat;
        updateData.Longitude = lng;
        updateData.position = `${lat},${lng}`;
      }

      await req.user.update(updateData);

      if (hasLocation) {
        await driverOnline(driverId, {
          latitude: lat,
          longitude: lng,
          bearing: bearing || 0,
          vehicle_category_id: req.user.vehicle_category_id,
          fcm_token: req.user.fcm_token,
        });
      } else {
        console.log(`Driver ${driverId} — online without location (GPS pending)`);
      }

    } else {
      await req.user.update({ order_status: 'offline' });
      await driverOffline(driverId);
    }

    if (req.io) {
      req.io.emit('driver_status_change', { driver_id: driverId, status });
    }

    return apiResponse(res, 200, true, 'Status updated', { status });
  } catch (err) {
    return apiResponse(res, 500, false, err.message);
  }
};

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