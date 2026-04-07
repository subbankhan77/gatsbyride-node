/**
 * Sequential Dispatch Queue — Ola/Uber style
 *
 * Flow:
 *   Order create → nearest driver[0] ko request bhejo
 *   30s timeout  → driver[1] ko bhejo
 *   Driver reject → foran driver[1] ko bhejo
 *   Driver accept → dispatch stop
 *   Saare drivers exhaust → order cancel, customer ko notify
 *
 * State: Redis `dispatch:{order_id}` mein stored (10 min TTL)
 * Timers: in-memory Map (process-local, restart pe reset)
 */

const { redis } = require('../config/redis');
const { Order, Customer } = require('../models');
const { sendNotification } = require('./fcm');
const { ORDER_STATUS } = require('../config/constants');

const metaKey = (driverId) => `driver:meta:${driverId}`;

const DRIVER_TIMEOUT_SEC = parseInt(process.env.DISPATCH_TIMEOUT_SEC) || 30;

const dispatchKey = (orderId) => `dispatch:${orderId}`;

// In-memory timers — orderId (string) → setTimeout handle
const dispatchTimers = new Map();

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Dispatch shuru karo
 * @param {number} orderId
 * @param {Array}  drivers  — [{driver_id, fcm_token, distance_km, ...}] sorted by distance
 * @param {object} io       — socket.io instance
 */
async function startDispatch(orderId, drivers, io) {
  if (!drivers || drivers.length === 0) {
    await _noDriverAvailable(orderId, io);
    return;
  }

  const state = { order_id: orderId, drivers, current_index: 0 };
  await redis.set(dispatchKey(orderId), JSON.stringify(state), 'EX', 600);
  await _sendToCurrentDriver(state, io);
}

/**
 * Next driver pe move karo (timeout ya reject ke baad)
 */
async function dispatchNext(orderId, io) {
  _clearTimer(orderId);

  const raw = await redis.get(dispatchKey(orderId));
  if (!raw) return; // dispatch already stopped

  const state = JSON.parse(raw);
  state.current_index += 1;

  if (state.current_index >= state.drivers.length) {
    await redis.del(dispatchKey(orderId));
    await _noDriverAvailable(orderId, io);
    return;
  }

  // Customer ko batao — dusra driver dhundh rahe hain
  const order = await Order.findByPk(orderId, { attributes: ['customer_id'] });
  if (io && order?.customer_id) {
    io.to(`customer_${order.customer_id}`).emit('lookingForDriver', {
      order_id: orderId,
      message: 'Looking for another driver...',
    });
  }

  await redis.set(dispatchKey(orderId), JSON.stringify(state), 'EX', 600);
  await _sendToCurrentDriver(state, io);
}

/**
 * Dispatch band karo (driver ne accept kiya)
 */
async function stopDispatch(orderId) {
  _clearTimer(orderId);
  await redis.del(dispatchKey(orderId));
  console.log(`✅ Dispatch stopped for order ${orderId}`);
}

/**
 * Current dispatch target driver return karo
 * (accept check ke liye — optional strict mode)
 */
async function getCurrentDispatchDriver(orderId) {
  const raw = await redis.get(dispatchKey(orderId));
  if (!raw) return null;
  const state = JSON.parse(raw);
  return state.drivers[state.current_index] || null;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function _clearTimer(orderId) {
  const key = String(orderId);
  if (dispatchTimers.has(key)) {
    clearTimeout(dispatchTimers.get(key));
    dispatchTimers.delete(key);
  }
}

async function _sendToCurrentDriver(state, io) {
  const { order_id, drivers, current_index } = state;
  const driver = drivers[current_index];
  const total = drivers.length;

  // Busy driver check — trip pe hai toh skip karo
  const meta = await redis.hgetall(metaKey(String(driver.driver_id)));
  if (meta && meta.is_available === '1') {
    console.log(`⏭️  Driver ${driver.driver_id} is busy — skipping`);
    state.current_index += 1;
    if (state.current_index >= state.drivers.length) {
      await redis.del(dispatchKey(order_id));
      await _noDriverAvailable(order_id, io);
      return;
    }
    await redis.set(dispatchKey(order_id), JSON.stringify(state), 'EX', 600);
    await _sendToCurrentDriver(state, io);
    return;
  }

  console.log(`📤 Dispatch order ${order_id} → Driver ${driver.driver_id} (${current_index + 1}/${total}, ${driver.distance_km?.toFixed(2) ?? '?'} km)`);

  // Order details fetch karo
  const order = await Order.findByPk(order_id, {
    attributes: [
      'id', 'customer_id', 'start_address', 'end_address',
      'start_coordinate', 'end_coordinate', 'total',
      'payment_method', 'vehicle_category_id', 'status',
    ],
  });

  // Order gone / already accepted
  if (!order || order.status !== ORDER_STATUS.PENDING) {
    await redis.del(dispatchKey(order_id));
    _clearTimer(order_id);
    return;
  }

  const payload = {
    order_id,
    customer_id: order.customer_id,
    start_address: order.start_address,
    end_address: order.end_address,
    start_coordinate: order.start_coordinate,
    end_coordinate: order.end_coordinate,
    total: order.total,
    payment_method: order.payment_method,
    vehicle_category_id: order.vehicle_category_id,
    distance_km: driver.distance_km ?? null,
    expires_in: DRIVER_TIMEOUT_SEC, // driver app countdown ke liye
  };

  // 1️⃣ Socket — driver connected ho toh turant mile
  if (io) {
    const room = io.sockets.adapter.rooms.get(`driver_${driver.driver_id}`);
    console.log(`🔔 Emitting CustomerBookRequest to driver_${driver.driver_id} — room size: ${room ? room.size : 0}`);
    io.to(`driver_${driver.driver_id}`).emit('CustomerBookRequest', payload);
  }

  // 2️⃣ FCM — background / killed app ke liye
  if (driver.fcm_token) {
    sendNotification(
      driver.fcm_token,
      '🚗 New Ride Request!',
      `Pickup: ${order.start_address || 'New location'}`,
      {
        type: 'new_ride',
        order_id:            String(order_id),
        customer_id:         String(order.customer_id),
        vehicle_category_id: String(order.vehicle_category_id || ''),
        start_address:       String(order.start_address || ''),
        end_address:         String(order.end_address || ''),
        total:               String(order.total || ''),
        payment_method:      String(order.payment_method || ''),
        expires_in:          String(DRIVER_TIMEOUT_SEC),
      }
    ).catch((err) => console.error(`FCM dispatch error driver ${driver.driver_id}:`, err.message));
  }

  // 3️⃣ Timeout — 30s baad next driver
  const timer = setTimeout(() => {
    console.log(`⏱️  Driver ${driver.driver_id} timed out for order ${order_id}`);
    dispatchNext(order_id, io);
  }, DRIVER_TIMEOUT_SEC * 1000);

  dispatchTimers.set(String(order_id), timer);
}

async function _noDriverAvailable(orderId, io) {
  console.log(`❌ No driver available for order ${orderId} — cancelling`);

  const order = await Order.findByPk(orderId, {
    attributes: ['id', 'customer_id', 'status'],
  });
  if (!order || order.status !== ORDER_STATUS.PENDING) return;

  // Order cancel karo
  await Order.update(
    { status: ORDER_STATUS.CANCEL },
    { where: { id: orderId, status: ORDER_STATUS.PENDING } }
  );

  // Socket — customer ko notify karo
  if (io && order.customer_id) {
    io.to(`customer_${order.customer_id}`).emit('noDriverAvailable', {
      order_id: orderId,
      message: 'No drivers available nearby. Please try again.',
    });
  }

  // FCM — agar customer app background mein ho
  const customer = await Customer.findByPk(order.customer_id, {
    attributes: ['fcm_token'],
  });
  if (customer?.fcm_token) {
    sendNotification(
      customer.fcm_token,
      'No Driver Available',
      'No drivers found nearby. Please try again.',
      { type: 'no_driver', order_id: String(orderId) }
    ).catch(() => {});
  }
}

module.exports = { startDispatch, dispatchNext, stopDispatch, getCurrentDispatchDriver };
