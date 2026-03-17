const { Op } = require('sequelize');
const {
  Order, Driver, Customer, VehicleCategory, Rating,
  OrderReject, Reason, Payment
} = require('../models');
const { sendNotification, sendMulticastNotification } = require('../utils/fcm');
const {
  haversineDistance, getDrivingDistance, getRoutePolyline,
  calculateFare, getSurgeMultiplier, checkPeakHour, apiResponse,
} = require('../utils/helpers');
const { getNearbyDrivers, getAllOnlineDrivers, getDriverLocationFromRedis } = require('../utils/driverLocation');
const { ORDER_STATUS } = require('../config/constants');
require('dotenv').config();

const NOTIFY_RADIUS_KM = parseFloat(process.env.NOTIFY_RADIUS_KM) || 100;

// ─── Create Order (Customer) ──────────────────────────────────────────────────
exports.createOrder = async (req, res) => {
  try {
    const {
      vehicle_category_id, start_coordinate, end_coordinate,
      start_address, end_address, distance, payment_method,
    } = req.body;

    const category = await VehicleCategory.findByPk(vehicle_category_id);
    if (!category) return apiResponse(res, 422, false, 'Vehicle category not found');

    // ── Surge Pricing ──────────────────────────────────────────────────────────
    const [customerLat, customerLng] = (start_coordinate || '0,0').split(',').map(Number);

    // Count pending/active orders near pickup (radius 5km) — MySQL (orders cache nahi hote)
    const nearbyActiveOrders = await Order.count({
      where: {
        status: { [Op.in]: [ORDER_STATUS.PENDING, ORDER_STATUS.DRIVER_ACCEPT, ORDER_STATUS.DEPARTURE_TO_CUSTOMER] },
      },
    });

    // Count free drivers near pickup — Redis Geo se (MySQL nahi)
    const nearbyDriversGeo = await getNearbyDrivers(customerLat, customerLng, 5, vehicle_category_id);
    const nearbyFreeDrivers = nearbyDriversGeo.length;

    const surgeMultiplier = getSurgeMultiplier(nearbyActiveOrders, nearbyFreeDrivers, { isPeakHour: checkPeakHour() });

    // ── Fare Calculation with Surge ────────────────────────────────────────────
    const baseFare = calculateFare(category, distance || 0);
    const total = parseFloat((baseFare * surgeMultiplier).toFixed(2));

    // ── Route Polyline (Google Directions) ────────────────────────────────────
    let routePolyline = null;
    let estimatedTime = null;
    if (start_coordinate && end_coordinate) {
      const routeData = await getRoutePolyline(start_coordinate, end_coordinate);
      if (routeData) {
        routePolyline = routeData.polyline;
        estimatedTime = Math.round(routeData.duration_value / 60); // seconds → minutes
      }
    }

    const order = await Order.create({
      customer_id: req.user.id,
      vehicle_category_id,
      start_coordinate,
      end_coordinate,
      start_address,
      end_address,
      distance,
      payment_method: payment_method || 'cash',
      status: ORDER_STATUS.PENDING,
      order_time: new Date(),
      total,
      surge_multiplier: surgeMultiplier,
      route_polyline: routePolyline,
      estimated_time: estimatedTime,
    });

    // Redis Geo se already nearby drivers mil gaye — FCM tokens filter karo
    const notifyDrivers = NOTIFY_RADIUS_KM > 5
      ? await getNearbyDrivers(customerLat, customerLng, NOTIFY_RADIUS_KM, vehicle_category_id)
      : nearbyDriversGeo;

    const nearbyFcmTokens = notifyDrivers.filter((d) => d.fcm_token).map((d) => d.fcm_token);
    const nearbyDriverIds = notifyDrivers.map((d) => d.driver_id);

    // FCM push notification to nearby drivers
    if (nearbyFcmTokens.length > 0) {
      await sendMulticastNotification(
        nearbyFcmTokens,
        'New Ride Request',
        `Pickup: ${start_address}`,
        {
          order_id: String(order.id),
          type: 'new_order',
          start_address,
          end_address,
        }
      );
    }

    // Socket.io emit to nearby drivers (includes surge + polyline info)
    if (req.io) {
      req.io.to('drivers_online').emit('new_order', {
        order_id: order.id,
        start_address,
        end_address,
        start_coordinate,
        end_coordinate,
        total,
        surge_multiplier: surgeMultiplier,
        route_polyline: routePolyline,
        estimated_time: estimatedTime,
        payment_method,
        vehicle_category_id,
        customer_id: req.user.id,
        nearby_driver_ids: nearbyDriverIds,
      });
    }

    return apiResponse(res, 201, true, 'Order created', order);
  } catch (err) {
    return apiResponse(res, 500, false, err.message);
  }
};

// ─── Update Order Status (Customer or Driver) ─────────────────────────────────
exports.updateOrderStatus = async (req, res) => {
  try {
    const { order_id, status } = req.body;

    const order = await Order.findByPk(order_id, {
      include: [
        { model: Customer },
        { model: Driver },
      ],
    });

    if (!order) return apiResponse(res, 404, false, 'Order not found');

    await order.update({ status });

    // Socket.io: notify relevant parties of status change
    if (req.io) {
      req.io.emit(`order_status_${order_id}`, { order_id, status });

      // Notify customer room
      req.io.to(`customer_${order.customer_id}`).emit('order_status_update', { order_id, status });

      // Notify driver room
      if (order.driver_id) {
        req.io.to(`driver_${order.driver_id}`).emit('order_status_update', { order_id, status });
      }
    }

    // FCM Push notifications based on status
    if (status == ORDER_STATUS.DRIVER_ACCEPT && order.Customer?.fcm_token) {
      await sendNotification(
        order.Customer.fcm_token,
        'Driver Accepted',
        'Your driver is on the way!',
        { order_id: String(order_id), type: 'driver_accept' }
      );
    } else if (status == ORDER_STATUS.COMPLETE && order.Driver?.fcm_token) {
      await sendNotification(
        order.Driver.fcm_token,
        'Trip Completed',
        'The trip has been completed.',
        { order_id: String(order_id), type: 'trip_complete' }
      );
    }

    return apiResponse(res, 200, true, 'Order status updated', order);
  } catch (err) {
    return apiResponse(res, 500, false, err.message);
  }
};

// ─── Customer: Get Active Orders ──────────────────────────────────────────────
exports.getCustomerOrders = async (req, res) => {
  try {
    const orders = await Order.findAll({
      where: { customer_id: req.user.id },
      include: [
        { model: Driver },
        { model: VehicleCategory },
      ],
      order: [['created_at', 'DESC']],
    });
    return apiResponse(res, 200, true, 'Orders', orders);
  } catch (err) {
    return apiResponse(res, 500, false, err.message);
  }
};

// ─── Customer: Order History ──────────────────────────────────────────────────
exports.customerOrderHistory = async (req, res) => {
  try {
    const orders = await Order.findAll({
      where: {
        customer_id: req.user.id,
        status: { [Op.in]: [ORDER_STATUS.COMPLETE, ORDER_STATUS.CANCEL] },
      },
      include: [{ model: Driver }, { model: VehicleCategory }],
      order: [['created_at', 'DESC']],
    });
    return apiResponse(res, 200, true, 'Order history', orders);
  } catch (err) {
    return apiResponse(res, 500, false, err.message);
  }
};

// ─── Customer: Check Order Status ────────────────────────────────────────────
exports.checkOrderStatusByUser = async (req, res) => {
  try {
    const { id } = req.params;
    const order = await Order.findOne({
      where: { id, customer_id: req.user.id },
      include: [{ model: Driver }, { model: VehicleCategory }],
    });
    if (!order) return apiResponse(res, 404, false, 'Order not found');
    return apiResponse(res, 200, true, 'Order status', order);
  } catch (err) {
    return apiResponse(res, 500, false, err.message);
  }
};

// ─── Driver: List Available Orders ───────────────────────────────────────────
exports.driverListOrders = async (req, res) => {
  try {
    const orders = await Order.findAll({
      where: { status: ORDER_STATUS.PENDING, driver_id: null },
      include: [{ model: Customer }, { model: VehicleCategory }],
      order: [['created_at', 'DESC']],
    });
    return apiResponse(res, 200, true, 'Available orders', orders);
  } catch (err) {
    return apiResponse(res, 500, false, err.message);
  }
};

// ─── Driver: Get Order Status ─────────────────────────────────────────────────
exports.driverGetOrderStatus = async (req, res) => {
  try {
    const order = await Order.findOne({
      where: { driver_id: req.user.id, status: { [Op.notIn]: [ORDER_STATUS.COMPLETE, ORDER_STATUS.CANCEL] } },
      include: [{ model: Customer }, { model: VehicleCategory }],
    });
    if (!order) return apiResponse(res, 404, false, 'No active order');
    return apiResponse(res, 200, true, 'Current order', order);
  } catch (err) {
    return apiResponse(res, 500, false, err.message);
  }
};

// ─── Driver: Update Order Status ──────────────────────────────────────────────
exports.driverUpdateOrderStatus = async (req, res) => {
  try {
    const { order_id, status, actual_distance, actual_time } = req.body;

    const order = await Order.findOne({
      where: { id: order_id, driver_id: req.user.id },
      include: [{ model: Customer }],
    });
    if (!order) return apiResponse(res, 404, false, 'Order not found');

    const updateData = { status };
    if (status == ORDER_STATUS.DRIVER_ACCEPT) {
      updateData.start_time = new Date();
      await Driver.update({ is_available: 1 }, { where: { id: req.user.id } });
    }
    if (status == ORDER_STATUS.COMPLETE || status == ORDER_STATUS.CANCEL) {
      updateData.end_time = new Date();
      if (actual_distance) updateData.actual_distance = actual_distance;
      if (actual_time) updateData.actual_time = actual_time;
      await Driver.update({ is_available: 0 }, { where: { id: req.user.id } });
    }

    await order.update(updateData);

    // Socket.io notification
    if (req.io) {
      req.io.to(`customer_${order.customer_id}`).emit('order_status_update', { order_id, status });
      req.io.to(`driver_${req.user.id}`).emit('order_status_update', { order_id, status });
    }

    // FCM to customer
    if (order.Customer?.fcm_token) {
      const titles = {
        [ORDER_STATUS.DRIVER_ACCEPT]: 'Driver Accepted',
        [ORDER_STATUS.DEPARTURE_TO_CUSTOMER]: 'Driver is on the way',
        [ORDER_STATUS.ARRIVAL_AT_CUSTOMER]: 'Driver arrived',
        [ORDER_STATUS.DEPARTURE_TO_DESTINATION]: 'Trip started',
        [ORDER_STATUS.ARRIVAL_AT_DESTINATION]: 'Arrived at destination',
        [ORDER_STATUS.COMPLETE]: 'Trip completed',
        [ORDER_STATUS.CANCEL]: 'Trip cancelled',
      };
      if (titles[status]) {
        await sendNotification(order.Customer.fcm_token, titles[status], '', { order_id: String(order_id), type: 'status_update', status: String(status) });
      }
    }

    return apiResponse(res, 200, true, 'Status updated', order);
  } catch (err) {
    return apiResponse(res, 500, false, err.message);
  }
};

// ─── Driver: Reject Order ────────────────────────────────────────────────────
exports.driverRejectOrder = async (req, res) => {
  try {
    const { order_id, reason } = req.body;

    await OrderReject.create({
      driver_id: req.user.id,
      order_id,
      reason,
      status: 1,
    });

    // Notify via socket
    if (req.io) {
      req.io.emit(`order_rejected_${order_id}`, { order_id, driver_id: req.user.id });
    }

    return apiResponse(res, 200, true, 'Order rejected');
  } catch (err) {
    return apiResponse(res, 500, false, err.message);
  }
};

// ─── Driver: Order History ───────────────────────────────────────────────────
exports.driverOrderHistory = async (req, res) => {
  try {
    const orders = await Order.findAll({
      where: {
        driver_id: req.user.id,
        status: { [Op.in]: [ORDER_STATUS.COMPLETE, ORDER_STATUS.CANCEL] },
      },
      include: [{ model: Customer }, { model: VehicleCategory }],
      order: [['created_at', 'DESC']],
    });
    return apiResponse(res, 200, true, 'Order history', orders);
  } catch (err) {
    return apiResponse(res, 500, false, err.message);
  }
};

// ─── Get Cancellation Reasons ─────────────────────────────────────────────────
exports.rejectReasonList = async (req, res) => {
  try {
    const reasons = await Reason.findAll({ where: { status: 1 } });
    return apiResponse(res, 200, true, 'Reasons', reasons);
  } catch (err) {
    return apiResponse(res, 500, false, err.message);
  }
};

// ─── Submit Rating ────────────────────────────────────────────────────────────
exports.submitRating = async (req, res) => {
  try {
    const { order_id, receiver_id, rating, review, type } = req.body;

    const ratingRecord = await Rating.create({
      sender_id: req.user.id,
      receiver_id,
      order_id,
      rating,
      review,
      type,
      status: 1,
    });

    return apiResponse(res, 201, true, 'Rating submitted', ratingRecord);
  } catch (err) {
    return apiResponse(res, 500, false, err.message);
  }
};

// ─── Get Rating List ──────────────────────────────────────────────────────────
exports.getRatingList = async (req, res) => {
  try {
    const { receiver_id, type } = req.body;
    const where = {};
    if (receiver_id) where.receiver_id = receiver_id;
    if (type) where.type = type;

    const ratings = await Rating.findAll({ where, include: [{ model: Order }] });
    return apiResponse(res, 200, true, 'Ratings', ratings);
  } catch (err) {
    return apiResponse(res, 500, false, err.message);
  }
};

// ─── Calculate Total Price ────────────────────────────────────────────────────
exports.getTotalPrice = async (req, res) => {
  try {
    const { vehicle_category_id, distance } = req.query;
    const category = await VehicleCategory.findByPk(vehicle_category_id);
    if (!category) return apiResponse(res, 404, false, 'Category not found');

    const total = calculateFare(category, parseFloat(distance || 0));
    return apiResponse(res, 200, true, 'Price calculated', { total });
  } catch (err) {
    return apiResponse(res, 500, false, err.message);
  }
};

// ─── Price by Category ────────────────────────────────────────────────────────
exports.priceCategory = async (req, res) => {
  try {
    const { vehicle_category_id, distance } = req.body;
    const category = await VehicleCategory.findByPk(vehicle_category_id);
    if (!category) return apiResponse(res, 404, false, 'Category not found');

    const total = calculateFare(category, parseFloat(distance || 0));
    return apiResponse(res, 200, true, 'Price', { total, category });
  } catch (err) {
    return apiResponse(res, 500, false, err.message);
  }
};

// ─── Get All Driver Locations ─────────────────────────────────────────────────
exports.getAllDriverLocations = async (req, res) => {
  try {
    // Redis se lo — MySQL full-scan nahi
    const drivers = await getAllOnlineDrivers();
    return apiResponse(res, 200, true, 'Driver locations', drivers);
  } catch (err) {
    return apiResponse(res, 500, false, err.message);
  }
};

// ─── Get Specific Driver Location ─────────────────────────────────────────────
exports.getDriverLocation = async (req, res) => {
  try {
    const { driver_id } = req.query;
    // Redis se location lo (fast) — MySQL se naam/image separately
    const [loc, driver] = await Promise.all([
      getDriverLocationFromRedis(driver_id),
      Driver.findByPk(driver_id, { attributes: ['id', 'name', 'image'] }),
    ]);
    if (!driver) return apiResponse(res, 404, false, 'Driver not found');
    return apiResponse(res, 200, true, 'Driver location', { ...driver.toJSON(), ...(loc || {}) });
  } catch (err) {
    return apiResponse(res, 500, false, err.message);
  }
};

// ─── Complete Trip ────────────────────────────────────────────────────────────
exports.updateEndTrip = async (req, res) => {
  try {
    const { order_id, actual_distance, actual_time } = req.body;
    const order = await Order.findOne({
      where: { id: order_id, driver_id: req.user.id },
      include: [{ model: Customer }],
    });
    if (!order) return apiResponse(res, 404, false, 'Order not found');

    const category = await VehicleCategory.findByPk(order.vehicle_category_id);
    const newTotal = calculateFare(category, parseFloat(actual_distance || order.distance), parseFloat(actual_time || 0));

    await order.update({
      status: ORDER_STATUS.COMPLETE,
      end_time: new Date(),
      actual_distance,
      actual_time,
      grand_total: newTotal,
    });

    await Driver.update({ is_available: 0 }, { where: { id: req.user.id } });

    if (req.io) {
      req.io.to(`customer_${order.customer_id}`).emit('trip_completed', { order_id, grand_total: newTotal });
    }

    if (order.Customer?.fcm_token) {
      await sendNotification(order.Customer.fcm_token, 'Trip Completed', `Total: ${newTotal}`, {
        order_id: String(order_id),
        type: 'trip_complete',
        grand_total: String(newTotal),
      });
    }

    return apiResponse(res, 200, true, 'Trip ended', order);
  } catch (err) {
    return apiResponse(res, 500, false, err.message);
  }
};

// ─── Get Driving Distance (Google Maps) ───────────────────────────────────────
exports.getDrivingDistanceRoute = async (req, res) => {
  try {
    const { pickup } = req.params;
    const { dropoff } = req.query;
    const result = await getDrivingDistance(pickup, dropoff || pickup);
    if (!result) return apiResponse(res, 500, false, 'Could not get distance');
    return apiResponse(res, 200, true, 'Distance calculated', result);
  } catch (err) {
    return apiResponse(res, 500, false, err.message);
  }
};

// ─── Driver: New Requests ─────────────────────────────────────────────────────
exports.driverNewRequests = async (req, res) => {
  try {
    const { latitude, longitude } = req.body;

    const orders = await Order.findAll({
      where: { status: ORDER_STATUS.PENDING, driver_id: null },
      include: [{ model: Customer }, { model: VehicleCategory }],
    });

    // Filter by driver location proximity
    const nearby = orders.filter((order) => {
      const [lat, lng] = (order.start_coordinate || '0,0').split(',').map(Number);
      const dist = haversineDistance(
        parseFloat(latitude || 0), parseFloat(longitude || 0),
        lat, lng
      );
      return dist <= NOTIFY_RADIUS_KM;
    });

    return apiResponse(res, 200, true, 'New requests', nearby);
  } catch (err) {
    return apiResponse(res, 500, false, err.message);
  }
};

// ─── Driver: Accept Order (assign driver to order) ────────────────────────────
exports.driverAcceptOrder = async (req, res) => {
  try {
    const { order_id } = req.body;
    const { sequelize } = require('../models');

    // Atomic UPDATE — sirf ek driver win karega, race condition impossible
    // driver_id = NULL check + status = PENDING check ek hi query mein
    const [affectedRows] = await Order.update(
      {
        driver_id: req.user.id,
        status: ORDER_STATUS.DRIVER_ACCEPT,
        start_time: new Date(),
      },
      {
        where: {
          id: order_id,
          status: ORDER_STATUS.PENDING,
          driver_id: null, // sirf unassigned order accept hoga
        },
      }
    );

    // 0 rows affected = kisi aur driver ne pehle le liya
    if (affectedRows === 0) {
      return apiResponse(res, 409, false, 'Order already accepted by another driver');
    }

    await Driver.update({ is_available: 1 }, { where: { id: req.user.id } });

    // Customer details fetch karo notification ke liye
    const order = await Order.findByPk(order_id, { include: [{ model: Customer }] });

    if (req.io) {
      req.io.to(`customer_${order.customer_id}`).emit('driver_accepted', {
        order_id,
        driver_id: req.user.id,
        status: ORDER_STATUS.DRIVER_ACCEPT,
      });
    }

    if (order.Customer?.fcm_token) {
      await sendNotification(
        order.Customer.fcm_token,
        'Driver Accepted',
        'Your driver is on the way!',
        { order_id: String(order_id), type: 'driver_accept' }
      );
    }

    return apiResponse(res, 200, true, 'Order accepted', order);
  } catch (err) {
    return apiResponse(res, 500, false, err.message);
  }
};

// ─── Get Order Route (polyline + steps for map) ───────────────────────────────
exports.getOrderRoute = async (req, res) => {
  try {
    const { order_id } = req.params;
    const order = await Order.findByPk(order_id, {
      attributes: ['id', 'start_coordinate', 'end_coordinate', 'start_address',
                   'end_address', 'route_polyline', 'estimated_time', 'status'],
    });
    if (!order) return apiResponse(res, 404, false, 'Order not found');

    // If polyline already saved, return it directly
    if (order.route_polyline) {
      return apiResponse(res, 200, true, 'Route', {
        order_id: order.id,
        route_polyline: order.route_polyline,
        estimated_time: order.estimated_time,
        start_coordinate: order.start_coordinate,
        end_coordinate: order.end_coordinate,
      });
    }

    // Fallback: fetch fresh from Google if not saved
    const routeData = await getRoutePolyline(order.start_coordinate, order.end_coordinate);
    if (!routeData) return apiResponse(res, 500, false, 'Could not get route');

    // Save for future calls
    await order.update({
      route_polyline: routeData.polyline,
      estimated_time: Math.round(routeData.duration_value / 60),
    });

    return apiResponse(res, 200, true, 'Route', {
      order_id: order.id,
      route_polyline: routeData.polyline,
      estimated_time: Math.round(routeData.duration_value / 60),
      distance_text: routeData.distance_text,
      duration_text: routeData.duration_text,
      steps: routeData.steps,
      start_coordinate: order.start_coordinate,
      end_coordinate: order.end_coordinate,
    });
  } catch (err) {
    return apiResponse(res, 500, false, err.message);
  }
};

// ─── Get Surge Info for a location ───────────────────────────────────────────
exports.getSurgeInfo = async (req, res) => {
  try {
    const { latitude, longitude, vehicle_category_id } = req.query;
    if (!latitude || !longitude) return apiResponse(res, 422, false, 'latitude and longitude required');

    const lat = parseFloat(latitude);
    const lng = parseFloat(longitude);

    // Active orders near this location — MySQL count (fast, no full-scan)
    const nearbyActive = await Order.count({
      where: {
        status: { [Op.in]: [ORDER_STATUS.PENDING, ORDER_STATUS.DRIVER_ACCEPT, ORDER_STATUS.DEPARTURE_TO_CUSTOMER] },
        ...(vehicle_category_id ? { vehicle_category_id } : {}),
      },
    });

    // Free drivers near this location — Redis Geo (fast)
    const nearbyDriversGeo = await getNearbyDrivers(lat, lng, 5, vehicle_category_id || null);
    const nearbyFree = nearbyDriversGeo.length;

    const isPeakHour = checkPeakHour();
    const surgeMultiplier = getSurgeMultiplier(nearbyActive, nearbyFree, { isPeakHour });

    return apiResponse(res, 200, true, 'Surge info', {
      surge_multiplier: surgeMultiplier,
      is_surge: surgeMultiplier > 1.0,
      is_peak_hour: isPeakHour,
      nearby_active_orders: nearbyActive,
      nearby_free_drivers: nearbyFree,
    });
  } catch (err) {
    return apiResponse(res, 500, false, err.message);
  }
};
