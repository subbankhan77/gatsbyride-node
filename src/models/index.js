const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

// ─── Customer Model ───────────────────────────────────────────────────────────
const Customer = sequelize.define('Customer', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  name: DataTypes.STRING,
  first_name: DataTypes.STRING,
  last_name: DataTypes.STRING,
  email: { type: DataTypes.STRING, unique: true },
  phone: DataTypes.STRING,
  password: DataTypes.STRING,
  otp: DataTypes.STRING,
  country: DataTypes.STRING,
  login_type: { type: DataTypes.ENUM('app', 'social'), defaultValue: 'app' },
  social_id: DataTypes.STRING,
  firebase_uid: DataTypes.STRING,
  fcm_token: DataTypes.TEXT,
  device_type: DataTypes.STRING,
  chat_token: DataTypes.STRING,
  status: { type: DataTypes.TINYINT, defaultValue: 1 },
  first_order: { type: DataTypes.BOOLEAN, defaultValue: false },
  image: DataTypes.STRING,
  latitude: DataTypes.DECIMAL(10, 8),
  longitude: DataTypes.DECIMAL(11, 8),
  api_token: DataTypes.TEXT,
  deleted_at: DataTypes.DATE,
}, {
  tableName: 'customers',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  paranoid: true,
  deletedAt: 'deleted_at',
});

// ─── Driver Model ─────────────────────────────────────────────────────────────
const Driver = sequelize.define('Driver', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  name: DataTypes.STRING,
  first_name: DataTypes.STRING,
  last_name: DataTypes.STRING,
  email: { type: DataTypes.STRING, unique: true },
  phone: DataTypes.STRING,
  password: DataTypes.STRING,
  otp: DataTypes.STRING,
  city: DataTypes.STRING,
  state: DataTypes.STRING,
  country: DataTypes.STRING,
  address: DataTypes.TEXT,
  postal_code: DataTypes.STRING,
  dob: DataTypes.DATE,
  id_number: DataTypes.STRING,
  profile_photo: DataTypes.STRING,
  driving_licence: DataTypes.STRING,
  driving_licence_back: DataTypes.STRING,
  id_proof: DataTypes.STRING,
  status: { type: DataTypes.TINYINT, defaultValue: 1 },
  order_status: { type: DataTypes.ENUM('offline', 'online'), defaultValue: 'offline' },
  profile_status: DataTypes.STRING,
  verification_status: DataTypes.TINYINT,
  bank_status: DataTypes.TINYINT,
  vehicle_category_id: DataTypes.INTEGER,
  plate_number: DataTypes.STRING,
  vehicle_name: DataTypes.STRING,
  car_model: DataTypes.STRING,
  insurance_number: DataTypes.STRING,
  firebase_uid: DataTypes.STRING,
  fcm_token: DataTypes.TEXT,
  device_type: DataTypes.STRING,
  chat_token: DataTypes.STRING,
  position: DataTypes.STRING,
  bearing: DataTypes.FLOAT,
  image: DataTypes.STRING,
  is_available: { type: DataTypes.TINYINT, defaultValue: 0 },
  Latitude: DataTypes.DECIMAL(10, 8),
  Longitude: DataTypes.DECIMAL(11, 8),
  api_token: DataTypes.TEXT,
  api_token_expired: DataTypes.DATE,
  deleted_at: DataTypes.DATE,
}, {
  tableName: 'drivers',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  paranoid: true,
  deletedAt: 'deleted_at',
});

// ─── VehicleCategory Model ────────────────────────────────────────────────────
const VehicleCategory = sequelize.define('VehicleCategory', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  category: DataTypes.STRING,
  image: DataTypes.STRING,
  price_km: DataTypes.DECIMAL(10, 2),
  price_min: DataTypes.DECIMAL(10, 2),
  tech_fee: DataTypes.DECIMAL(10, 2),
  base_fare: DataTypes.DECIMAL(10, 2),
  distance: DataTypes.DECIMAL(10, 2),
  min_km: DataTypes.DECIMAL(10, 2),
  min_price: DataTypes.DECIMAL(10, 2),
  extra_km: DataTypes.DECIMAL(10, 2),
  night_service: DataTypes.DECIMAL(10, 2),
  seat: DataTypes.INTEGER,
  deleted_at: DataTypes.DATE,
}, {
  tableName: 'vehicle_categories',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  paranoid: true,
  deletedAt: 'deleted_at',
});

// ─── Order Model ──────────────────────────────────────────────────────────────
const Order = sequelize.define('Order', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  driver_id: DataTypes.INTEGER,
  customer_id: DataTypes.INTEGER,
  vehicle_category_id: DataTypes.INTEGER,
  start_coordinate: DataTypes.STRING,
  end_coordinate: DataTypes.STRING,
  start_address: DataTypes.TEXT,
  end_address: DataTypes.TEXT,
  distance: DataTypes.DECIMAL(10, 2),
  one_way: DataTypes.BOOLEAN,
  order_time: DataTypes.DATE,
  start_time: DataTypes.DATE,
  end_time: DataTypes.DATE,
  actual_distance: DataTypes.DECIMAL(10, 2),
  actual_time: DataTypes.DECIMAL(10, 2),
  estimated_time: DataTypes.DECIMAL(10, 2),
  payment_method: { type: DataTypes.ENUM('cash', 'card', 'wallet'), defaultValue: 'cash' },
  status: { type: DataTypes.TINYINT, defaultValue: 0 },
  total: DataTypes.DECIMAL(10, 2),
  pending_amount: DataTypes.DECIMAL(10, 2),
  new_total: DataTypes.DECIMAL(10, 2),
  grand_total: DataTypes.DECIMAL(10, 2),
  // Surge pricing multiplier (1.00 = normal, 1.50 = 1.5x surge)
  // ALTER TABLE orders ADD COLUMN surge_multiplier DECIMAL(4,2) DEFAULT 1.00;
  surge_multiplier: { type: DataTypes.DECIMAL(4, 2), defaultValue: 1.00 },
  // Encoded polyline from Google Directions API for road-following route on map
  // ALTER TABLE orders ADD COLUMN route_polyline LONGTEXT NULL;
  route_polyline: DataTypes.TEXT('long'),
}, {
  tableName: 'orders',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
});

// ─── Rating Model ─────────────────────────────────────────────────────────────
const Rating = sequelize.define('Rating', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  sender_id: DataTypes.INTEGER,
  receiver_id: DataTypes.INTEGER,
  order_id: DataTypes.INTEGER,
  rating: DataTypes.TINYINT,
  review: DataTypes.TEXT,
  type: DataTypes.TINYINT,  // 1=customer→driver, 2=driver→customer
  status: DataTypes.BOOLEAN,
}, {
  tableName: 'rating',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
});

// ─── OrderReject Model ────────────────────────────────────────────────────────
const OrderReject = sequelize.define('OrderReject', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  driver_id: DataTypes.INTEGER,
  order_id: DataTypes.INTEGER,
  reason: DataTypes.TEXT,
  status: DataTypes.TINYINT,
}, {
  tableName: 'order_reject',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
});

// ─── Reasons Model ────────────────────────────────────────────────────────────
const Reason = sequelize.define('Reason', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  reason: DataTypes.STRING,
  status: DataTypes.TINYINT,
}, {
  tableName: 'reasons',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
});

// ─── BankDetails Model ────────────────────────────────────────────────────────
const BankDetails = sequelize.define('BankDetails', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  driver_id: DataTypes.INTEGER,
  account_holder_name: DataTypes.STRING,
  bank_name: DataTypes.STRING,
  account_number: DataTypes.STRING,
  transit_number: DataTypes.STRING,
  institution_number: DataTypes.STRING,
  status: DataTypes.TINYINT,
}, {
  tableName: 'driver_bank_details',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
});

// ─── Payment Model ────────────────────────────────────────────────────────────
const Payment = sequelize.define('Payment', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  driver_id: DataTypes.INTEGER,
  order_id: DataTypes.INTEGER,
  transaction_id: DataTypes.STRING,
  tip: DataTypes.FLOAT,
  total: DataTypes.FLOAT,
  status: { type: DataTypes.TINYINT, defaultValue: 0 },
}, {
  tableName: 'payments',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
});

// ─── UserCardDetails Model ────────────────────────────────────────────────────
const UserCardDetails = sequelize.define('UserCardDetails', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  user_id: DataTypes.INTEGER,
  card_number: DataTypes.STRING,
  card_holder_name: DataTypes.STRING,
  card_type: DataTypes.STRING,
  expiry_date: DataTypes.STRING,
  status: DataTypes.TINYINT,
}, {
  tableName: 'user_card_details',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
});

// ─── ContactUs Model ──────────────────────────────────────────────────────────
const ContactUs = sequelize.define('ContactUs', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  name: DataTypes.STRING,
  email: DataTypes.STRING,
  message: DataTypes.TEXT,
}, {
  tableName: 'contactus',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
});

// ─── AboutUs Model ────────────────────────────────────────────────────────────
const AboutUs = sequelize.define('AboutUs', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  content: DataTypes.TEXT,
  status: DataTypes.TINYINT,
}, {
  tableName: 'abouts',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
});

// ─── OrderSetting Model ───────────────────────────────────────────────────────
const OrderSetting = sequelize.define('OrderSetting', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  key: DataTypes.STRING,
  value: DataTypes.STRING,
}, {
  tableName: 'order_settings',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
});

// ─── Notification Model ───────────────────────────────────────────────────────
const Notification = sequelize.define('Notification', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  user_id: DataTypes.INTEGER,
  token: DataTypes.TEXT,
}, {
  tableName: 'notifications',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
});

// ─── User (Admin) Model ───────────────────────────────────────────────────────
const AdminUser = sequelize.define('AdminUser', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  name: DataTypes.STRING,
  username: DataTypes.STRING,
  email: DataTypes.STRING,
  password: DataTypes.STRING,
  status: DataTypes.TINYINT,
}, {
  tableName: 'users',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
});

// ─── Associations ─────────────────────────────────────────────────────────────
Driver.belongsTo(VehicleCategory, { foreignKey: 'vehicle_category_id' });
VehicleCategory.hasMany(Driver, { foreignKey: 'vehicle_category_id' });

Order.belongsTo(Driver, { foreignKey: 'driver_id' });
Order.belongsTo(Customer, { foreignKey: 'customer_id' });
Order.belongsTo(VehicleCategory, { foreignKey: 'vehicle_category_id' });
Order.hasMany(Rating, { foreignKey: 'order_id' });
Order.hasMany(Payment, { foreignKey: 'order_id' });

Driver.hasMany(BankDetails, { foreignKey: 'driver_id' });

Rating.belongsTo(Order, { foreignKey: 'order_id' });

OrderReject.belongsTo(Driver, { foreignKey: 'driver_id' });
OrderReject.belongsTo(Order, { foreignKey: 'order_id' });

BankDetails.belongsTo(Driver, { foreignKey: 'driver_id' });
Payment.belongsTo(Driver, { foreignKey: 'driver_id' });
Payment.belongsTo(Order, { foreignKey: 'order_id' });
UserCardDetails.belongsTo(Customer, { foreignKey: 'user_id', as: 'customer' });

module.exports = {
  sequelize,
  Customer,
  Driver,
  VehicleCategory,
  Order,
  Rating,
  OrderReject,
  Reason,
  BankDetails,
  Payment,
  UserCardDetails,
  ContactUs,
  AboutUs,
  OrderSetting,
  Notification,
  AdminUser,
};
