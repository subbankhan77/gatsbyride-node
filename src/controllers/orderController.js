const { Op } = require('sequelize');
const {
  Order, Driver, Customer, VehicleCategory, Rating,
  OrderReject, Reason, ChatMessage, Payment,
} = require('../models');
const { sendNotification } = require('../utils/fcm');
const {
  haversineDistance, getDrivingDistance, getRoutePolyline,
  calculateFare, getSurgeMultiplier, checkPeakHour, apiResponse,
} = require('../utils/helpers');
const { getNearbyDrivers, getAllOnlineDrivers, getDriverLocationFromRedis, setDriverBusy, setDriverFree } = require('../utils/driverLocation');
const { startDispatch, dispatchNext, stopDispatch } = require('../utils/dispatchQueue');
const { ORDER_STATUS } = require('../config/constants');
require('dotenv').config();

const NOTIFY_RADIUS_KM = parseFloat(process.env.NOTIFY_RADIUS_KM) || 100;

exports.createOrder = async (req, res) => {
  try {
    const {
      vehicle_category_id, start_coordinate, end_coordinate,
      start_address, end_address, distance, payment_method,
    } = req.body;

    const category = await VehicleCategory.findByPk(vehicle_category_id);
    if (!category) return apiResponse(res, 422, false, 'Vehicle category not found');

    const [customerLat, customerLng] = (start_coordinate || '0,0').split(',').map(Number);

    const nearbyActiveOrders = await Order.count({
      where: {
        status: { [Op.in]: [ORDER_STATUS.PENDING, ORDER_STATUS.DRIVER_ACCEPT, ORDER_STATUS.DEPARTURE_TO_CUSTOMER] },
      },
    });

    const nearbyDriversGeo = await getNearbyDrivers(customerLat, customerLng, 5, vehicle_category_id);
    const nearbyFreeDrivers = nearbyDriversGeo.length;

    const surgeMultiplier = getSurgeMultiplier(nearbyActiveOrders, nearbyFreeDrivers, { isPeakHour: checkPeakHour() });

    const baseFare = calculateFare(category, distance || 0);
    const total = parseFloat((baseFare * surgeMultiplier).toFixed(2));

    let routePolyline = null;
    let estimatedTime = null;
    if (start_coordinate && end_coordinate) {
      const routeData = await getRoutePolyline(start_coordinate, end_coordinate);
      if (routeData) {
        routePolyline = routeData.polyline;
        estimatedTime = Math.round(routeData.duration_value / 60);
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

    let dispatchDrivers = await getNearbyDrivers(customerLat, customerLng, NOTIFY_RADIUS_KM, vehicle_category_id);

    if (dispatchDrivers.length === 0) {
      console.log('Redis empty — falling back to MySQL for dispatch');
      const mysqlDrivers = await Driver.findAll({
        where: {
          order_status: 'online',
          status: 1,
          verification_status: 1,
          ...(vehicle_category_id ? { vehicle_category_id } : {}),
        },
        attributes: ['id', 'fcm_token', 'Latitude', 'Longitude'],
      });
      dispatchDrivers = mysqlDrivers
        .map((d) => ({
          driver_id: d.id,
          fcm_token: d.fcm_token,
          latitude: d.Latitude,
          longitude: d.Longitude,
          distance_km: (d.Latitude && d.Longitude)
            ? haversineDistance(customerLat, customerLng, parseFloat(d.Latitude), parseFloat(d.Longitude))
            : null,
        }))
        .sort((a, b) => (a.distance_km ?? Infinity) - (b.distance_km ?? Infinity));
    }

    console.log(`🚀 Starting dispatch for order ${order.id} — ${dispatchDrivers.length} drivers in queue`);

    startDispatch(order.id, dispatchDrivers, req.io).catch((err) =>
      console.error('Dispatch error:', err.message)
    );

    return apiResponse(res, 201, true, 'Order created', order);
  } catch (err) {
    return apiResponse(res, 500, false, err.message);
  }
};

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

    if (status == ORDER_STATUS.CANCEL) {
      stopDispatch(order_id).catch(() => {});
      if (order.driver_id) {
        setDriverFree(order.driver_id).catch(() => {});
      }
    }

    await order.update({ status });

    if (req.io) {
      req.io.emit(`order_status_${order_id}`, { order_id, status });
      req.io.to(`customer_${order.customer_id}`).emit('order_status_update', { order_id, status });
      if (order.driver_id) {
        req.io.to(`driver_${order.driver_id}`).emit('order_status_update', { order_id, status });
      }
    }

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
      setDriverBusy(req.user.id).catch(() => {});
      stopDispatch(order_id).catch(() => {});
    }
    if (status == ORDER_STATUS.COMPLETE || status == ORDER_STATUS.CANCEL) {
      updateData.end_time = new Date();
      if (actual_distance) updateData.actual_distance = actual_distance;
      if (actual_time) updateData.actual_time = actual_time;
      await Driver.update({ is_available: 0 }, { where: { id: req.user.id } });
      setDriverFree(req.user.id).catch(() => {});
    }

    await order.update(updateData);

    if (req.io) {
      req.io.to(`customer_${order.customer_id}`).emit('order_status_update', { order_id, status });
      req.io.to(`driver_${req.user.id}`).emit('order_status_update', { order_id, status });
    }

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

exports.driverRejectOrder = async (req, res) => {
  try {
    const { order_id, reason } = req.body;

    await OrderReject.create({
      driver_id: req.user.id,
      order_id,
      reason,
      status: 1,
    });

    dispatchNext(order_id, req.io).catch((err) =>
      console.error('dispatchNext error:', err.message)
    );

    return apiResponse(res, 200, true, 'Order rejected');
  } catch (err) {
    return apiResponse(res, 500, false, err.message);
  }
};

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

exports.rejectReasonList = async (req, res) => {
  try {
    const reasons = await Reason.findAll({ where: { status: 1 } });
    return apiResponse(res, 200, true, 'Reasons', reasons);
  } catch (err) {
    return apiResponse(res, 500, false, err.message);
  }
};

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

exports.getAllDriverLocations = async (req, res) => {
  try {
    const drivers = await getAllOnlineDrivers();
    return apiResponse(res, 200, true, 'Driver locations', drivers);
  } catch (err) {
    return apiResponse(res, 500, false, err.message);
  }
};

exports.getDriverLocation = async (req, res) => {
  try {
    const { driver_id } = req.query;
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
    setDriverFree(req.user.id).catch(() => {});

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

exports.driverNewRequests = async (req, res) => {
  try {
    const { latitude, longitude } = req.body;

    const orders = await Order.findAll({
      where: { status: ORDER_STATUS.PENDING, driver_id: null },
      include: [{ model: Customer }, { model: VehicleCategory }],
    });

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

exports.driverAcceptOrder = async (req, res) => {
  try {
    const { order_id } = req.body;

    const driver = await Driver.findByPk(req.user.id, { attributes: ['verification_status', 'status'] });
    if (!driver || driver.verification_status !== 1) {
      return apiResponse(res, 403, false, 'Account not verified. Please complete verification to accept orders.');
    }
    if (driver.status !== 1) {
      return apiResponse(res, 403, false, 'Your account is suspended.');
    }

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
          driver_id: null,
        },
      }
    );

    if (affectedRows === 0) {
      return apiResponse(res, 409, false, 'Order already accepted by another driver');
    }

    await Driver.update({ is_available: 1 }, { where: { id: req.user.id } });
    setDriverBusy(req.user.id).catch(() => {});

    await stopDispatch(order_id);

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

exports.getOrderRoute = async (req, res) => {
  try {
    const { order_id } = req.params;
    const order = await Order.findByPk(order_id, {
      attributes: ['id', 'start_coordinate', 'end_coordinate', 'start_address',
                   'end_address', 'route_polyline', 'estimated_time', 'status'],
    });
    if (!order) return apiResponse(res, 404, false, 'Order not found');

    if (order.route_polyline) {
      return apiResponse(res, 200, true, 'Route', {
        order_id: order.id,
        route_polyline: order.route_polyline,
        estimated_time: order.estimated_time,
        start_coordinate: order.start_coordinate,
        end_coordinate: order.end_coordinate,
      });
    }

    const routeData = await getRoutePolyline(order.start_coordinate, order.end_coordinate);
    if (!routeData) return apiResponse(res, 500, false, 'Could not get route');

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

exports.getChatHistory = async (req, res) => {
  try {
    const { order_id } = req.params;

    const order = await Order.findOne({
      where: {
        id: order_id,
        [Op.or]: [{ customer_id: req.user.id }, { driver_id: req.user.id }],
      },
      attributes: ['id'],
    });
    if (!order) return apiResponse(res, 404, false, 'Order not found');

    const messages = await ChatMessage.findAll({
      where: { order_id },
      order: [['created_at', 'ASC']],
    });

    return apiResponse(res, 200, true, 'Chat history', messages);
  } catch (err) {
    return apiResponse(res, 500, false, err.message);
  }
};

exports.driverOrderReceipt = async (req, res) => {
  try {
    const { id, time, distance } = req.body;
    const order = await Order.findByPk(id, {
      include: [{ model: Customer }, { model: VehicleCategory }],
    });
    if (!order) return apiResponse(res, 404, false, 'Order not found');

    const actualMinutes = parseFloat(time) || 0;
    const actualDistance = parseFloat(distance) || 0;
    const category = order.VehicleCategory;

    let extraTimeMin = 0;
    let extraTimeFare = 0;
    if (order.estimated_time && actualMinutes > order.estimated_time) {
      extraTimeMin = parseFloat((actualMinutes - order.estimated_time).toFixed(2));
      const pricePerMin = parseFloat(category?.price_min) || 0;
      extraTimeFare = parseFloat((extraTimeMin * pricePerMin).toFixed(2));
    }

    let extraDistance = 0;
    let extraDistanceFare = 0;
    if (actualDistance > parseFloat(order.distance)) {
      extraDistance = parseFloat((actualDistance - parseFloat(order.distance)).toFixed(2));
      const pricePerKm = parseFloat(category?.price_km) || 0;
      extraDistanceFare = parseFloat((extraDistance * pricePerKm).toFixed(2));
    }

    const grandTotal = parseFloat((parseFloat(order.total) + extraDistanceFare + extraTimeFare).toFixed(2));

    const tip = parseFloat((await Payment.findOne({ where: { order_id: id } }))?.tip || 0);
    const pendingAmount = parseFloat(order.Customer?.pending_amount || 0);
    const newTotal = parseFloat((grandTotal + pendingAmount).toFixed(2));

    await order.update({
      actual_distance: actualDistance,
      actual_time: actualMinutes,
      grand_total: grandTotal + tip,
      new_total: newTotal,
    });

    return apiResponse(res, 200, true, 'Order receipt', {
      id: String(order.id),
      driver_id: String(order.driver_id),
      distance: String(order.distance),
      total: String(order.total),
      grand_total: (grandTotal + tip).toFixed(2),
      extra_distance: extraDistance.toFixed(2),
      extra_distance_price: extraDistanceFare.toFixed(2),
      extra_time: extraTimeMin.toFixed(2),
      extra_time_price: extraTimeFare === 0 ? '0' : extraTimeFare.toFixed(2),
      tip: tip.toFixed(2),
      order_time: order.order_time,
      start_time: order.start_time,
      end_time: order.end_time,
      status: String(order.status),
      vehicle_category_id: order.vehicle_category_id,
      image: order.Customer?.image || '-',
      user_name: order.Customer?.name || '-',
      user_phone: order.Customer?.phone || '-',
      payment_method: order.payment_method,
      pending_amount: pendingAmount.toFixed(2),
      new_total: newTotal.toFixed(2),
    });
  } catch (err) {
    return apiResponse(res, 500, false, err.message);
  }
};

exports.getSurgeInfo = async (req, res) => {
  try {
    const { latitude, longitude, vehicle_category_id } = req.query;
    if (!latitude || !longitude) return apiResponse(res, 422, false, 'latitude and longitude required');

    const lat = parseFloat(latitude);
    const lng = parseFloat(longitude);

    const nearbyActive = await Order.count({
      where: {
        status: { [Op.in]: [ORDER_STATUS.PENDING, ORDER_STATUS.DRIVER_ACCEPT, ORDER_STATUS.DEPARTURE_TO_CUSTOMER] },
        ...(vehicle_category_id ? { vehicle_category_id } : {}),
      },
    });

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
