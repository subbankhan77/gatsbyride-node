const { Driver, Customer, Order, ChatMessage } = require('../models');
const jwt = require('jsonwebtoken');
const { getLiveETA } = require('../utils/helpers');
const { sendNotification } = require('../utils/fcm');
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

      // Redis update — fast, no MySQL hit
      await updateDriverLocation(driverId, { latitude, longitude, bearing, vehicle_category_id });

      // MySQL sync — sirf har 30 seconds mein
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

      if (customer_id) io.to(`customer_${customer_id}`).emit('order_status_update', { order_id, status });
      if (driver_id) io.to(`driver_${driver_id}`).emit('order_status_update', { order_id, status });
      io.to(`order_${order_id}`).emit('order_status_update', { order_id, status });
    });

    // ── Driver Accept Order ──────────────────────────────────────────────────
    socket.on('driver_accept_order', (data) => {
      const { order_id, driver_id, customer_id } = data;
      io.to(`customer_${customer_id}`).emit('driver_accepted', {
        order_id,
        driver_id: driver_id || socket.userId,
        status: 1,
      });
    });

    // ── NEW: Customer Books Ride → Online Drivers Ko Notify Karo ─────────────
    socket.on('UserBookDriver', async (data) => {
      const {
        UserID,
        OrderID,
        vehicle_category_id,
        start_coordinate,
        end_coordinate,
        start_address,
        end_address,
        total,
        payment_method,
      } = data;

      console.log(`🚗 UserBookDriver received: OrderID=${OrderID} CustomerID=${UserID} Category=${vehicle_category_id}`);

      try {
        // Order DB mein verify karo
        const order = await Order.findByPk(OrderID);
        if (!order) {
          console.log(`❌ Order ${OrderID} not found in DB`);
          socket.emit('noDriverAvailable', { order_id: OrderID, message: 'Order not found' });
          return;
        }

        // Customer ko apne rooms mein join karo
        socket.join(`customer_${UserID}`);
        socket.join(`order_${OrderID}`);
        console.log(`Customer ${UserID} joined order_${OrderID} room`);

        // Online drivers check karo (socket room se)
        const driversRoom = io.sockets.adapter.rooms.get('drivers_online');
        const socketOnlineCount = driversRoom ? driversRoom.size : 0;
        console.log(`drivers_online room mein: ${socketOnlineCount} drivers`);

        // Ride request payload
        const ridePayload = {
          order_id: OrderID,
          customer_id: UserID,
          vehicle_category_id,
          start_coordinate,
          end_coordinate,
          start_address,
          end_address,
          total,
          payment_method,
        };

        // 1️⃣ Socket se — online drivers ko turant bhejo
        if (socketOnlineCount > 0) {
          io.to('drivers_online').emit('newRideRequest', ridePayload);
          console.log(`✅ newRideRequest socket event sent to ${socketOnlineCount} drivers`);
        }

        // 2️⃣ FCM se — DB mein online drivers ko (background/killed app ke liye)
        const dbDrivers = await Driver.findAll({
          where: {
            order_status: 'online',
            vehicle_category_id: vehicle_category_id,
          },
          attributes: ['id', 'fcm_token'],
        });

        console.log(`DB mein online drivers (category ${vehicle_category_id}): ${dbDrivers.length}`);

        let fcmSentCount = 0;
        for (const driver of dbDrivers) {
          if (driver.fcm_token) {
            await sendNotification(
              driver.fcm_token,
              '🚗 New Ride Request!',
              `Pickup: ${start_address || 'New location'}`,
              {
                type: 'new_ride',
                order_id: String(OrderID),
                customer_id: String(UserID),
                vehicle_category_id: String(vehicle_category_id),
                start_address: String(start_address || ''),
                end_address: String(end_address || ''),
                total: String(total || ''),
                payment_method: String(payment_method || ''),
              }
            ).catch(err => console.error(`FCM error driver ${driver.id}:`, err.message));
            fcmSentCount++;
          }
        }

        console.log(`✅ FCM sent to ${fcmSentCount} drivers`);

        // Agar koi bhi driver nahi mila
        if (socketOnlineCount === 0 && dbDrivers.length === 0) {
          console.log('⚠️ Koi bhi driver available nahi hai');
          socket.emit('noDriverAvailable', {
            order_id: OrderID,
            message: 'No drivers available at the moment',
          });
        }

      } catch (err) {
        console.error('❌ UserBookDriver error:', err.message);
        socket.emit('noDriverAvailable', {
          order_id: OrderID,
          message: 'Server error occurred',
        });
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
        console.log(`Driver ${driverId} is now offline`);
      }
    });
  });
}

module.exports = setupSocket;