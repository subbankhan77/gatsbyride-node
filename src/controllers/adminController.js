const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Op } = require('sequelize');
const {
  AdminUser, Customer, Driver, Order, VehicleCategory,
  Rating, Payment, Reason, AboutUs, BankDetails, OrderSetting
} = require('../models');
const { apiResponse } = require('../utils/helpers');

// ─── Admin Login ──────────────────────────────────────────────────────────────
exports.login = async (req, res) => {
  try {
    const { username, password } = req.body;

    const admin = await AdminUser.findOne({ where: { username } });
    if (!admin) return apiResponse(res, 422, false, 'Username not found');

    const valid = await bcrypt.compare(password, admin.password);
    if (!valid) return apiResponse(res, 422, false, 'Invalid password');

    if (admin.status === 0) return apiResponse(res, 403, false, 'Account suspended');

    const token = jwt.sign(
      { id: admin.id, role: 'admin', username: admin.username },
      process.env.JWT_SECRET,
      { expiresIn: '1d' }
    );

    await admin.update({ remember_token: token });

    const { password: _, remember_token: __, ...adminData } = admin.toJSON();
    return apiResponse(res, 200, true, 'Login successful', { token, admin: adminData });
  } catch (err) {
    return apiResponse(res, 500, false, err.message);
  }
};

// ─── Dashboard Stats ──────────────────────────────────────────────────────────
exports.dashboard = async (req, res) => {
  try {
    const [
      totalCustomers,
      totalDrivers,
      totalOrders,
      completedOrders,
      cancelledOrders,
      pendingOrders,
      onlineDrivers,
      totalRevenue,
    ] = await Promise.all([
      Customer.count({ where: { deleted_at: null } }),
      Driver.count({ where: { deleted_at: null } }),
      Order.count(),
      Order.count({ where: { status: 7 } }),
      Order.count({ where: { status: 8 } }),
      Order.count({ where: { status: 0 } }),
      Driver.count({ where: { order_status: 'online' } }),
      Payment.sum('total', { where: { status: 1 } }),
    ]);

    return apiResponse(res, 200, true, 'Dashboard stats', {
      total_customers: totalCustomers,
      total_drivers: totalDrivers,
      total_orders: totalOrders,
      completed_orders: completedOrders,
      cancelled_orders: cancelledOrders,
      pending_orders: pendingOrders,
      online_drivers: onlineDrivers,
      total_revenue: totalRevenue || 0,
    });
  } catch (err) {
    return apiResponse(res, 500, false, err.message);
  }
};

// ═════════════════════════════════════════════════════════════════════════════
//  CUSTOMER MANAGEMENT
// ═════════════════════════════════════════════════════════════════════════════

exports.getCustomers = async (req, res) => {
  try {
    const { search, page = 1, limit = 20 } = req.query;
    const where = { deleted_at: null };
    if (search) {
      where[Op.or] = [
        { name: { [Op.like]: `%${search}%` } },
        { email: { [Op.like]: `%${search}%` } },
        { phone: { [Op.like]: `%${search}%` } },
      ];
    }
    const offset = (page - 1) * limit;
    const { count, rows } = await Customer.findAndCountAll({
      where, limit: parseInt(limit), offset: parseInt(offset),
      order: [['created_at', 'DESC']],
    });
    return apiResponse(res, 200, true, 'Customers', { total: count, page: parseInt(page), data: rows });
  } catch (err) {
    return apiResponse(res, 500, false, err.message);
  }
};

exports.getCustomer = async (req, res) => {
  try {
    const customer = await Customer.findByPk(req.params.id);
    if (!customer) return apiResponse(res, 404, false, 'Customer not found');
    return apiResponse(res, 200, true, 'Customer', customer);
  } catch (err) {
    return apiResponse(res, 500, false, err.message);
  }
};

exports.updateCustomer = async (req, res) => {
  try {
    const customer = await Customer.findByPk(req.params.id);
    if (!customer) return apiResponse(res, 404, false, 'Customer not found');
    const { name, email, phone, status } = req.body;
    await customer.update({ name, email, phone, status });
    return apiResponse(res, 200, true, 'Customer updated', customer);
  } catch (err) {
    return apiResponse(res, 500, false, err.message);
  }
};

exports.deleteCustomer = async (req, res) => {
  try {
    const customer = await Customer.findByPk(req.params.id);
    if (!customer) return apiResponse(res, 404, false, 'Customer not found');
    await customer.destroy();
    return apiResponse(res, 200, true, 'Customer deleted');
  } catch (err) {
    return apiResponse(res, 500, false, err.message);
  }
};

exports.toggleCustomerStatus = async (req, res) => {
  try {
    const customer = await Customer.findByPk(req.params.id);
    if (!customer) return apiResponse(res, 404, false, 'Customer not found');
    await customer.update({ status: customer.status === 1 ? 0 : 1 });
    return apiResponse(res, 200, true, `Customer ${customer.status === 1 ? 'activated' : 'suspended'}`, customer);
  } catch (err) {
    return apiResponse(res, 500, false, err.message);
  }
};

// ═════════════════════════════════════════════════════════════════════════════
//  DRIVER MANAGEMENT
// ═════════════════════════════════════════════════════════════════════════════

exports.getDrivers = async (req, res) => {
  try {
    const { search, page = 1, limit = 20, status } = req.query;
    const where = { deleted_at: null };
    if (search) {
      where[Op.or] = [
        { name: { [Op.like]: `%${search}%` } },
        { email: { [Op.like]: `%${search}%` } },
        { phone: { [Op.like]: `%${search}%` } },
        { plate_number: { [Op.like]: `%${search}%` } },
      ];
    }
    if (status !== undefined) where.status = status;
    const offset = (page - 1) * limit;
    const { count, rows } = await Driver.findAndCountAll({
      where,
      include: [{ model: VehicleCategory }],
      limit: parseInt(limit), offset: parseInt(offset),
      order: [['created_at', 'DESC']],
    });
    return apiResponse(res, 200, true, 'Drivers', { total: count, page: parseInt(page), data: rows });
  } catch (err) {
    return apiResponse(res, 500, false, err.message);
  }
};

exports.getDriver = async (req, res) => {
  try {
    const driver = await Driver.findByPk(req.params.id, {
      include: [{ model: VehicleCategory }, { model: BankDetails }],
    });
    if (!driver) return apiResponse(res, 404, false, 'Driver not found');
    return apiResponse(res, 200, true, 'Driver', driver);
  } catch (err) {
    return apiResponse(res, 500, false, err.message);
  }
};

exports.updateDriver = async (req, res) => {
  try {
    const driver = await Driver.findByPk(req.params.id);
    if (!driver) return apiResponse(res, 404, false, 'Driver not found');
    const { name, email, phone, status, verification_status, vehicle_category_id } = req.body;
    await driver.update({ name, email, phone, status, verification_status, vehicle_category_id });
    return apiResponse(res, 200, true, 'Driver updated', driver);
  } catch (err) {
    return apiResponse(res, 500, false, err.message);
  }
};

exports.deleteDriver = async (req, res) => {
  try {
    const driver = await Driver.findByPk(req.params.id);
    if (!driver) return apiResponse(res, 404, false, 'Driver not found');
    await driver.destroy();
    return apiResponse(res, 200, true, 'Driver deleted');
  } catch (err) {
    return apiResponse(res, 500, false, err.message);
  }
};

exports.toggleDriverStatus = async (req, res) => {
  try {
    const driver = await Driver.findByPk(req.params.id);
    if (!driver) return apiResponse(res, 404, false, 'Driver not found');
    await driver.update({ status: driver.status === 1 ? 0 : 1 });
    return apiResponse(res, 200, true, 'Driver status updated', driver);
  } catch (err) {
    return apiResponse(res, 500, false, err.message);
  }
};

exports.toggleDriverVerification = async (req, res) => {
  try {
    const driver = await Driver.findByPk(req.params.id);
    if (!driver) return apiResponse(res, 404, false, 'Driver not found');
    await driver.update({ verification_status: driver.verification_status === 1 ? 0 : 1 });
    return apiResponse(res, 200, true, 'Verification status updated', driver);
  } catch (err) {
    return apiResponse(res, 500, false, err.message);
  }
};

// Get all online drivers with live location (for map tracking)
exports.getOnlineDrivers = async (req, res) => {
  try {
    const drivers = await Driver.findAll({
      where: { order_status: 'online', status: 1 },
      attributes: ['id', 'name', 'Latitude', 'Longitude', 'bearing', 'vehicle_category_id', 'image', 'plate_number', 'is_available'],
      include: [{ model: VehicleCategory, attributes: ['category', 'image'] }],
    });
    return apiResponse(res, 200, true, 'Online drivers', drivers);
  } catch (err) {
    return apiResponse(res, 500, false, err.message);
  }
};

// ═════════════════════════════════════════════════════════════════════════════
//  ORDER MANAGEMENT
// ═════════════════════════════════════════════════════════════════════════════

exports.getOrders = async (req, res) => {
  try {
    const { search, page = 1, limit = 20, status } = req.query;
    const where = {};
    if (status !== undefined) where.status = status;
    if (search) {
      where[Op.or] = [
        { start_address: { [Op.like]: `%${search}%` } },
        { end_address: { [Op.like]: `%${search}%` } },
      ];
    }
    const offset = (page - 1) * limit;
    const { count, rows } = await Order.findAndCountAll({
      where,
      include: [
        { model: Customer, attributes: ['id', 'name', 'email', 'phone'] },
        { model: Driver, attributes: ['id', 'name', 'email', 'phone'] },
        { model: VehicleCategory, attributes: ['id', 'category'] },
      ],
      limit: parseInt(limit), offset: parseInt(offset),
      order: [['created_at', 'DESC']],
    });
    return apiResponse(res, 200, true, 'Orders', { total: count, page: parseInt(page), data: rows });
  } catch (err) {
    return apiResponse(res, 500, false, err.message);
  }
};

exports.getOrder = async (req, res) => {
  try {
    const order = await Order.findByPk(req.params.id, {
      include: [
        { model: Customer },
        { model: Driver },
        { model: VehicleCategory },
        { model: Rating },
        { model: Payment },
      ],
    });
    if (!order) return apiResponse(res, 404, false, 'Order not found');
    return apiResponse(res, 200, true, 'Order', order);
  } catch (err) {
    return apiResponse(res, 500, false, err.message);
  }
};

// ═════════════════════════════════════════════════════════════════════════════
//  VEHICLE CATEGORY MANAGEMENT
// ═════════════════════════════════════════════════════════════════════════════

exports.getVehicleCategories = async (req, res) => {
  try {
    const categories = await VehicleCategory.findAll({ order: [['created_at', 'DESC']] });
    return apiResponse(res, 200, true, 'Vehicle categories', categories);
  } catch (err) {
    return apiResponse(res, 500, false, err.message);
  }
};

exports.createVehicleCategory = async (req, res) => {
  try {
    const {
      category, price_km, price_min, tech_fee, base_fare,
      distance, min_km, min_price, extra_km, night_service, seat
    } = req.body;
    const image = req.file ? req.file.filename : null;

    const cat = await VehicleCategory.create({
      category, image, price_km, price_min, tech_fee, base_fare,
      distance, min_km, min_price, extra_km, night_service, seat,
    });
    return apiResponse(res, 201, true, 'Category created', cat);
  } catch (err) {
    return apiResponse(res, 500, false, err.message);
  }
};

exports.updateVehicleCategory = async (req, res) => {
  try {
    const cat = await VehicleCategory.findByPk(req.params.id);
    if (!cat) return apiResponse(res, 404, false, 'Category not found');

    const {
      category, price_km, price_min, tech_fee, base_fare,
      distance, min_km, min_price, extra_km, night_service, seat
    } = req.body;
    const image = req.file ? req.file.filename : undefined;

    const updateData = { category, price_km, price_min, tech_fee, base_fare, distance, min_km, min_price, extra_km, night_service, seat };
    if (image) updateData.image = image;

    await cat.update(updateData);
    return apiResponse(res, 200, true, 'Category updated', cat);
  } catch (err) {
    return apiResponse(res, 500, false, err.message);
  }
};

exports.deleteVehicleCategory = async (req, res) => {
  try {
    const cat = await VehicleCategory.findByPk(req.params.id);
    if (!cat) return apiResponse(res, 404, false, 'Category not found');
    await cat.destroy();
    return apiResponse(res, 200, true, 'Category deleted');
  } catch (err) {
    return apiResponse(res, 500, false, err.message);
  }
};

// ═════════════════════════════════════════════════════════════════════════════
//  ADMIN USER MANAGEMENT
// ═════════════════════════════════════════════════════════════════════════════

exports.getAdmins = async (req, res) => {
  try {
    const admins = await AdminUser.findAll({
      attributes: { exclude: ['password'] },
      order: [['created_at', 'DESC']],
    });
    return apiResponse(res, 200, true, 'Admins', admins);
  } catch (err) {
    return apiResponse(res, 500, false, err.message);
  }
};

exports.createAdmin = async (req, res) => {
  try {
    const { name, username, password } = req.body;
    const exists = await AdminUser.findOne({ where: { username } });
    if (exists) return apiResponse(res, 422, false, 'Username already exists');

    const hashed = await bcrypt.hash(password, 10);
    const admin = await AdminUser.create({ name, username, password: hashed, status: 1 });
    const { password: _, ...adminData } = admin.toJSON();
    return apiResponse(res, 201, true, 'Admin created', adminData);
  } catch (err) {
    return apiResponse(res, 500, false, err.message);
  }
};

exports.updateAdmin = async (req, res) => {
  try {
    const admin = await AdminUser.findByPk(req.params.id);
    if (!admin) return apiResponse(res, 404, false, 'Admin not found');
    const { name, username, password, status } = req.body;
    const updateData = { name, username, status };
    if (password) updateData.password = await bcrypt.hash(password, 10);
    await admin.update(updateData);
    return apiResponse(res, 200, true, 'Admin updated');
  } catch (err) {
    return apiResponse(res, 500, false, err.message);
  }
};

exports.deleteAdmin = async (req, res) => {
  try {
    const admin = await AdminUser.findByPk(req.params.id);
    if (!admin) return apiResponse(res, 404, false, 'Admin not found');
    if (admin.id === req.admin.id) return apiResponse(res, 400, false, 'Cannot delete yourself');
    await admin.destroy();
    return apiResponse(res, 200, true, 'Admin deleted');
  } catch (err) {
    return apiResponse(res, 500, false, err.message);
  }
};

// ═════════════════════════════════════════════════════════════════════════════
//  CANCELLATION REASONS
// ═════════════════════════════════════════════════════════════════════════════

exports.getReasons = async (req, res) => {
  try {
    const reasons = await Reason.findAll({ order: [['created_at', 'DESC']] });
    return apiResponse(res, 200, true, 'Reasons', reasons);
  } catch (err) {
    return apiResponse(res, 500, false, err.message);
  }
};

exports.createReason = async (req, res) => {
  try {
    const reason = await Reason.create({ reason: req.body.reason, status: 1 });
    return apiResponse(res, 201, true, 'Reason created', reason);
  } catch (err) {
    return apiResponse(res, 500, false, err.message);
  }
};

exports.updateReason = async (req, res) => {
  try {
    const reason = await Reason.findByPk(req.params.id);
    if (!reason) return apiResponse(res, 404, false, 'Reason not found');
    await reason.update({ reason: req.body.reason, status: req.body.status });
    return apiResponse(res, 200, true, 'Reason updated', reason);
  } catch (err) {
    return apiResponse(res, 500, false, err.message);
  }
};

exports.deleteReason = async (req, res) => {
  try {
    const reason = await Reason.findByPk(req.params.id);
    if (!reason) return apiResponse(res, 404, false, 'Reason not found');
    await reason.destroy();
    return apiResponse(res, 200, true, 'Reason deleted');
  } catch (err) {
    return apiResponse(res, 500, false, err.message);
  }
};

// ═════════════════════════════════════════════════════════════════════════════
//  ABOUT US
// ═════════════════════════════════════════════════════════════════════════════

exports.getAboutUs = async (req, res) => {
  try {
    const about = await AboutUs.findOne();
    return apiResponse(res, 200, true, 'About us', about);
  } catch (err) {
    return apiResponse(res, 500, false, err.message);
  }
};

exports.updateAboutUs = async (req, res) => {
  try {
    let about = await AboutUs.findOne();
    if (about) {
      await about.update({ content: req.body.content, status: 1 });
    } else {
      about = await AboutUs.create({ content: req.body.content, status: 1 });
    }
    return apiResponse(res, 200, true, 'About us updated', about);
  } catch (err) {
    return apiResponse(res, 500, false, err.message);
  }
};

// ═════════════════════════════════════════════════════════════════════════════
//  ORDER SETTINGS
// ═════════════════════════════════════════════════════════════════════════════

exports.getSettings = async (req, res) => {
  try {
    const settings = await OrderSetting.findAll();
    return apiResponse(res, 200, true, 'Settings', settings);
  } catch (err) {
    return apiResponse(res, 500, false, err.message);
  }
};

exports.updateSettings = async (req, res) => {
  try {
    const { settings } = req.body; // [{ key, value }]
    for (const s of settings) {
      await OrderSetting.upsert({ key: s.key, value: s.value });
    }
    return apiResponse(res, 200, true, 'Settings updated');
  } catch (err) {
    return apiResponse(res, 500, false, err.message);
  }
};

// ─── Admin Logout ─────────────────────────────────────────────────────────────
exports.logout = async (req, res) => {
  try {
    await req.admin.update({ remember_token: null });
    return apiResponse(res, 200, true, 'Logged out successfully');
  } catch (err) {
    return apiResponse(res, 500, false, err.message);
  }
};
