const { Driver, Order } = require('../models');
const jwt = require('jsonwebtoken');
const { getLiveETA } = require('../utils/helpers');
const {
  driverOnline,
  updateDriverLocation,
  driverOffline,
  getDriverLocationFromRedis,
} = require('../utils/driverLocation');

// ETA throttle — order per 30 seconds
const lastEtaUpdate = new Map();

// MySQL location sync — every 30s per driver (persistence ke liye)
const lastMysqlSync = new Map();
const MYSQL_SYNC_INTERVAL = 30000; // 30 seconds

function setupSocket(io) {
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

    // ── Customer: Join personal room ──────────────────────────────────────────
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

        // MySQL status update (sirf status, location nahi)
        await Driver.update({ order_status: 'online' }, { where: { id: driverId } });
      }

      socket.broadcast.emit('driver_online', { driver_id: driverId });
      console.log(`Driver ${driverId} is online`);
    });

    // ── Driver: Location update → Redis Geo (fast) ────────────────────────────
    socket.on('driver_location', async (data) => {
      const { driver_id, latitude, longitude, bearing, order_id, vehicle_category_id } = data;
      const driverId = driver_id || socket.userId;

      // Redis update — microseconds, no MySQL hit
      await updateDriverLocation(driverId, { latitude, longitude, bearing, vehicle_category_id });

      // MySQL sync — sirf har 30 seconds mein (persistence)
      const now = Date.now();
      const lastSync = lastMysqlSync.get(driverId) || 0;
      if (now - lastSync >= MYSQL_SYNC_INTERVAL) {
        lastMysqlSync.set(driverId, now);
        Driver.update(
          { Latitude: latitude, Longitude: longitude, bearing, position: `${latitude},${longitude}` },
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

    // ── Join Order Room ───────────────────────────────────────────────────────
    socket.on('join_order', (data) => {
      const { order_id } = data;
      if (order_id) {
        socket.join(`order_${order_id}`);
      }
    });

    // ── Order Status Update ───────────────────────────────────────────────────
    socket.on('order_status_update', async (data) => {
      const { order_id, status, driver_id, customer_id } = data;

      await Order.update({ status }, { where: { id: order_id } });

      if (customer_id) io.to(`customer_${customer_id}`).emit('order_status_update', { order_id, status });
      if (driver_id) io.to(`driver_${driver_id}`).emit('order_status_update', { order_id, status });
      io.to(`order_${order_id}`).emit('order_status_update', { order_id, status });
    });

    // ── Driver Accept Order ───────────────────────────────────────────────────
    socket.on('driver_accept_order', (data) => {
      const { order_id, driver_id, customer_id } = data;
      io.to(`customer_${customer_id}`).emit('driver_accepted', {
        order_id,
        driver_id: driver_id || socket.userId,
        status: 1,
      });
    });

    // ── Simple Chat (driver ↔ customer) ───────────────────────────────────────
    socket.on('send_message', (data) => {
      const { to_room, message, sender_id, sender_type } = data;
      io.to(to_room).emit('receive_message', {
        message,
        sender_id: sender_id || socket.userId,
        sender_type,
        timestamp: new Date().toISOString(),
      });
    });

    // ── Disconnect ────────────────────────────────────────────────────────────
    socket.on('disconnect', async () => {
      console.log(`Socket disconnected: ${socket.id}`);

      if (socket.userGuard === 'driver' && socket.userId) {
        const driverId = socket.userId;

        // Final MySQL location sync before going offline
        try {
          const loc = await getDriverLocationFromRedis(driverId);
          if (loc) {
            await Driver.update(
              { Latitude: loc.latitude, Longitude: loc.longitude, order_status: 'offline' },
              { where: { id: driverId } }
            );
          } else {
            await Driver.update({ order_status: 'offline' }, { where: { id: driverId } });
          }
        } catch (e) {
          console.error('Disconnect sync error:', e.message);
        }

        // Redis se hata do
        await driverOffline(driverId).catch(() => {});
        lastMysqlSync.delete(driverId);

        io.emit('driver_offline', { driver_id: driverId });
      }
    });
  });
}

module.exports = setupSocket;
