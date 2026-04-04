const { Driver, Customer, Order, ChatMessage } = require('../models');
const jwt = require('jsonwebtoken');
const { getLiveETA } = require('../utils/helpers');
const { sendNotification } = require('../utils/fcm');
const {
  driverOnline,
  updateDriverLocation,
  driverOffline,
  setDriverBusy,
  setDriverFree,
} = require('../utils/driverLocation');
const { stopDispatch } = require('../utils/dispatchQueue');

// ETA throttle — order per 30 seconds
const lastEtaUpdate = new Map();

// MySQL location sync — every 30s per driver (persistence ke liye)
const lastMysqlSync = new Map();
const MYSQL_SYNC_INTERVAL = 30000; // 30 seconds

// Grace period: driver disconnect ke 30s baad offline mark karo
// Agar 30s mein reconnect kare toh cancel ho jaayega
const offlineTimers = new Map();

function setupSocket(io) {
  // ── JWT Auth Middleware ───────────────────────────────────────────────────
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token || socket.handshake.query?.token;
    if (!token) {
      return next(new Error('Authentication required'));
    }
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      socket.userId = decoded.id;
      socket.userGuard = decoded.guard; // 'customer' or 'driver'
      next();
    } catch (err) {
      return next(new Error('Invalid token'));
    }
  });

  io.on('connection', (socket) => {
    console.log(`Socket connected: ${socket.id} | user: ${socket.userId} | guard: ${socket.userGuard}`);

    // ── Customer: Join personal room ─────────────────────────────────────────
    socket.on('join_customer', (data) => {
      const customerId = data?.customer_id || socket.userId;
      if (customerId) {
        socket.join(`customer_${customerId}`);
        console.log(`Customer ${customerId} joined room`);
      }
    });

    // ── Driver: Join personal room + Redis Geo online ─────────────────────────
    socket.on('join_driver', async (data) => {
      const driverId = data?.driver_id || socket.userId;
      if (!driverId) return;

      // Agar pending offline timer hai toh cancel karo (reconnect hua)
      if (offlineTimers.has(driverId)) {
        clearTimeout(offlineTimers.get(driverId));
        offlineTimers.delete(driverId);
        console.log(`Driver ${driverId} reconnected — offline timer cancelled`);
      }

      socket.join(`driver_${driverId}`);
      socket.join('drivers_online');
      socket.driverId = driverId; // disconnect ke liye save karo

      // Driver ka vehicle_category aur fcm_token MySQL se ek baar lo
      const driver = await Driver.findByPk(driverId, {
        attributes: ['id', 'vehicle_category_id', 'fcm_token', 'Latitude', 'Longitude'],
      });

      if (driver) {
        // Redis Geo mein daalo
        await driverOnline(driverId, {
          latitude: driver.Latitude || 0,
          longitude: driver.Longitude || 0,
          vehicle_category_id: driver.vehicle_category_id,
          fcm_token: driver.fcm_token,
        });

        // MySQL status update
        await Driver.update({ order_status: 'online' }, { where: { id: driverId } });
      }

      socket.broadcast.emit('driver_online', { driver_id: driverId });
      console.log(`Driver ${driverId} is online`);
    });

    // ── Driver: Location update → Redis Geo (fast) ───────────────────────────
    socket.on('driver_location', async (data) => {
      const { driver_id, latitude, longitude, bearing, order_id, vehicle_category_id } = data;
      const driverId = driver_id || socket.userId;

      const lat = parseFloat(latitude);
      const lng = parseFloat(longitude);
      if (isNaN(lat) || isNaN(lng)) {
        console.warn(`[driver_location] Invalid lat/lng from driver ${driverId}: lat=${latitude} lng=${longitude}`);
        return;
      }

      // Redis update — fast, no MySQL hit
      try {
        await updateDriverLocation(driverId, { latitude: lat, longitude: lng, bearing, vehicle_category_id });
      } catch (redisErr) {
        console.error(`[driver_location] Redis error for driver ${driverId}:`, redisErr.message);
      }

      // MySQL sync — sirf har 30 seconds mein
      const now = Date.now();
      const lastSync = lastMysqlSync.get(driverId) || 0;
      if (now - lastSync >= MYSQL_SYNC_INTERVAL) {
        lastMysqlSync.set(driverId, now);
        Driver.update(
          { Latitude: lat, Longitude: lng, bearing, position: `${lat},${lng}` },
          { where: { id: driverId } }
        ).catch((err) => console.error('MySQL location sync error:', err.message));
      }

      const locationPayload = { driver_id: driverId, latitude, longitude, bearing };
      io.emit('driver_location_update', locationPayload);

      // Active trip: order room + ETA update
      if (order_id) {
        io.to(`order_${order_id}`).emit('driver_location_update', { ...locationPayload, order_id });

        const lastUpdate = lastEtaUpdate.get(order_id) || 0;
        if (now - lastUpdate >= 30000) {
          lastEtaUpdate.set(order_id, now);
          try {
            const order = await Order.findByPk(order_id, { attributes: ['end_coordinate', 'customer_id'] });
            if (order?.end_coordinate) {
              const [destLat, destLng] = order.end_coordinate.split(',').map(Number);
              const eta = await getLiveETA(latitude, longitude, destLat, destLng);
              if (eta) {
                const etaPayload = {
                  order_id,
                  driver_id: driverId,
                  eta_seconds: eta.duration_value,
                  eta_text: eta.duration_text,
                  distance_text: eta.distance_text,
                };
                io.to(`customer_${order.customer_id}`).emit('eta_update', etaPayload);
                io.to(`order_${order_id}`).emit('eta_update', etaPayload);
              }
            }
          } catch (etaErr) {
            console.error('ETA update error:', etaErr.message);
          }
        }
      }
    });

    // ── Join Order Room ──────────────────────────────────────────────────────
    socket.on('join_order', (data) => {
      const { order_id } = data;
      if (order_id) {
        socket.join(`order_${order_id}`);
      }
    });

    // ── Order Status Update ──────────────────────────────────────────────────
    socket.on('order_status_update', async (data) => {
      const { order_id, status, driver_id, customer_id } = data;

      await Order.update({ status }, { where: { id: order_id } });

      // Cancel → dispatch band karo + driver free karo
      if (status == 8) { // ORDER_STATUS.CANCEL
        stopDispatch(order_id).catch(() => {});
        if (driver_id) setDriverFree(driver_id).catch(() => {});
      }

      if (customer_id) io.to(`customer_${customer_id}`).emit('order_status_update', { order_id, status });
      if (driver_id) io.to(`driver_${driver_id}`).emit('order_status_update', { order_id, status });
      io.to(`order_${order_id}`).emit('order_status_update', { order_id, status });
    });

    // ── Driver Accept Order (socket se accept) ───────────────────────────────
    socket.on('driver_accept_order', async (data) => {
      const { order_id, driver_id, customer_id } = data;
      const dId = driver_id || socket.userId;

      // Dispatch band karo + driver busy mark karo
      stopDispatch(order_id).catch(() => {});
      setDriverBusy(dId).catch(() => {});

      io.to(`customer_${customer_id}`).emit('driver_accepted', {
        order_id,
        driver_id: dId,
        status: 1,
      });
    });

    // ── NEW: Customer Books Ride → Online Drivers Ko Notify Karo ─────────────
    // ── UserBookDriver — sirf customer ko order room mein join karao ──────────
    // Dispatch ab createOrder (HTTP) se start hota hai — yahan broadcast nahi hoga
    socket.on('UserBookDriver', async (data) => {
      const { UserID, OrderID } = data;
      console.log(`🚗 UserBookDriver: Customer ${UserID} joining order_${OrderID} room`);
      try {
        const order = await Order.findByPk(OrderID, { attributes: ['id', 'customer_id'] });
        if (!order) {
          socket.emit('noDriverAvailable', { order_id: OrderID, message: 'Order not found' });
          return;
        }
        socket.join(`customer_${UserID}`);
        socket.join(`order_${OrderID}`);
        console.log(`Customer ${UserID} joined order_${OrderID} room`);
      } catch (err) {
        console.error('❌ UserBookDriver error:', err.message);
      }
    });

    // ── Simple Chat (driver ↔ customer) ──────────────────────────────────────
    socket.on('send_message', async (data) => {
      const { to_room, message, sender_id, sender_type, receiver_id, order_id } = data;
      const actualSenderId = sender_id || socket.userId;

      const msgPayload = {
        message,
        sender_id: actualSenderId,
        sender_type,
        order_id,
        timestamp: new Date().toISOString(),
      };

      // Online users ko deliver karo
      io.to(to_room).emit('receive_message', msgPayload);

      // DB mein save karo
      ChatMessage.create({
        order_id: order_id || null,
        sender_id: actualSenderId,
        sender_type: sender_type || 'customer',
        receiver_id: receiver_id || null,
        message,
      }).catch((err) => console.error('Chat save error:', err.message));

      // Receiver offline hai to FCM bhejo
      if (receiver_id) {
        const roomSize = io.sockets.adapter.rooms.get(to_room)?.size || 0;
        if (roomSize === 0) {
          const ReceiverModel = sender_type === 'driver' ? Customer : Driver;
          const receiver = await ReceiverModel.findByPk(receiver_id, {
            attributes: ['fcm_token'],
          }).catch(() => null);

          if (receiver?.fcm_token) {
            sendNotification(
              receiver.fcm_token,
              'New Message',
              String(message).substring(0, 100),
              {
                type: 'chat',
                order_id: String(order_id || ''),
                sender_id: String(actualSenderId),
                sender_type: String(sender_type || ''),
              }
            ).catch((err) => console.error('Chat FCM error:', err.message));
          }
        }
      }
    });

    // ── Disconnect ───────────────────────────────────────────────────────────
    socket.on('disconnect', async () => {
      console.log(`Socket disconnected: ${socket.id} | user: ${socket.userId}`);

      if (socket.userGuard === 'driver' && socket.userId) {
        const driverId = socket.userId;

        // Redis se foran hata do (location stale ho jaayegi)
        await driverOffline(driverId).catch(() => {});
        lastMysqlSync.delete(driverId);
        io.emit('driver_offline', { driver_id: driverId });
        console.log(`Driver ${driverId} disconnected — waiting 30s before marking offline`);

        // MySQL mein 30s grace period ke baad offline karo
        // Agar driver 30s mein reconnect kare toh join_driver timer cancel karega
        const timer = setTimeout(async () => {
          offlineTimers.delete(driverId);
          try {
            await Driver.update({ order_status: 'offline' }, { where: { id: driverId } });
            console.log(`Driver ${driverId} is now offline (grace period expired)`);
          } catch (e) {
            console.error('Offline sync error:', e.message);
          }
        }, 30000);

        offlineTimers.set(driverId, timer);
      }
    });
  });
}

module.exports = setupSocket;