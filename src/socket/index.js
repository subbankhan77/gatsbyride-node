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
const { redis } = require('../config/redis');
const { attachSocketLogger } = require('../middleware/logger');

const lastEtaUpdate = new Map();

const lastMysqlSync = new Map();
const MYSQL_SYNC_INTERVAL = 30000;

const offlineTimers = new Map();

function setupSocket(io) {
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token || socket.handshake.query?.token;
    if (!token) {
      return next(new Error('Authentication required'));
    }
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      socket.userId = decoded.id;
      socket.userGuard = decoded.guard;
      next();
    } catch (err) {
      return next(new Error('Invalid token'));
    }
  });

  io.on('connection', (socket) => {
    console.log(`Socket connected: ${socket.id} | user: ${socket.userId} | guard: ${socket.userGuard}`);
    attachSocketLogger(socket);

    socket.on('join_customer', (data) => {
      const customerId = data?.customer_id || socket.userId;
      if (customerId) {
        socket.join(`customer_${customerId}`);
        const roomSize = io.sockets.adapter.rooms.get(`customer_${customerId}`)?.size || 0;
        console.log(`Customer ${customerId} joined room — room size: ${roomSize}`);
      }
    });

    socket.on('join_driver', async (data) => {
      try {
        const driverId = data?.driver_id || socket.userId;
        if (!driverId) return;

        const driverIdStr = String(driverId);
        if (offlineTimers.has(driverIdStr)) {
          clearTimeout(offlineTimers.get(driverIdStr));
          offlineTimers.delete(driverIdStr);
          console.log(`Driver ${driverId} reconnected — offline timer cancelled`);
        }

        socket.join(`driver_${driverId}`);
        socket.join('drivers_online');
        socket.driverId = driverId;
        await redis.set(`driver:connected:${driverIdStr}`, '1', 'EX', 120);
        const clientLat = data?.latitude ? parseFloat(data.latitude) : null;
        const clientLng = data?.longitude ? parseFloat(data.longitude) : null;
        const clientBearing = data?.bearing ? parseFloat(data.bearing) : null;
        const driver = await Driver.findByPk(driverId, {
          attributes: ['id', 'vehicle_category_id', 'fcm_token', 'Latitude', 'Longitude'],
        });

        if (!driver) {
          console.warn(`join_driver: Driver ${driverId} not found in DB`);
          return;
        }

        const lat = clientLat !== null ? clientLat : (parseFloat(driver.Latitude) || 0);
        const lng = clientLng !== null ? clientLng : (parseFloat(driver.Longitude) || 0);

        const mysqlUpdate = { order_status: 'online' };
        if (clientLat !== null && clientLng !== null && !isNaN(clientLat) && !isNaN(clientLng)) {
          mysqlUpdate.Latitude = clientLat;
          mysqlUpdate.Longitude = clientLng;
          mysqlUpdate.position = `${clientLat},${clientLng}`;
          if (clientBearing !== null && !isNaN(clientBearing)) {
            mysqlUpdate.bearing = clientBearing;
          }
        }

        await Promise.allSettled([
          Driver.update(mysqlUpdate, { where: { id: driverId } }),
          driverOnline(driverId, {
            latitude: lat,
            longitude: lng,
            bearing: clientBearing ?? 0,
            vehicle_category_id: driver.vehicle_category_id,
            fcm_token: driver.fcm_token,
          }),
        ]).then((results) => {
          if (results[0].status === 'rejected') console.error(`join_driver MySQL error driver ${driverId}:`, results[0].reason?.message);
          if (results[1].status === 'rejected') console.error(`join_driver Redis error driver ${driverId}:`, results[1].reason?.message);
        });

        socket.broadcast.emit('driver_online', { driver_id: driverId });
        console.log(`Driver ${driverId} is online (lat=${lat}, lng=${lng})`);
      } catch (err) {
        console.error(`join_driver unhandled error:`, err.message);
      }
    });

    socket.on('driver_location', async (data) => {
      const { driver_id, latitude, longitude, bearing, order_id, vehicle_category_id } = data;
      const driverId = driver_id || socket.userId;

      const lat = parseFloat(latitude);
      const lng = parseFloat(longitude);
      if (isNaN(lat) || isNaN(lng)) {
        console.warn(`[driver_location] Invalid lat/lng from driver ${driverId}: lat=${latitude} lng=${longitude}`);
        return;
      }

      try {
        await updateDriverLocation(driverId, { latitude: lat, longitude: lng, bearing, vehicle_category_id });
      } catch (redisErr) {
        console.error(`[driver_location] Redis error for driver ${driverId}:`, redisErr.message);
      }

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
        stopDispatch(order_id).catch(() => { });
        if (driver_id) setDriverFree(driver_id).catch(() => { });
      }

      if (customer_id) io.to(`customer_${customer_id}`).emit('order_status_update', { order_id, status });
      if (driver_id) io.to(`driver_${driver_id}`).emit('order_status_update', { order_id, status });
      io.to(`order_${order_id}`).emit('order_status_update', { order_id, status });
    });

    // ── Driver: message event handler (PHP legacy format) ───────────────────
    socket.on('message', async (data) => {
      const { serviceType, UserID, orderID, order_id: order_id_snake } = data;
      const driverId = UserID || socket.userId;

      if (serviceType === 'Accept') {
        // orderID null/undefined aaye toh Redis se reverse lookup karo
        let resolvedOrderId = orderID || order_id_snake;
        if (!resolvedOrderId) {
          const pending = await redis.get(`driver:pending_order:${driverId}`);
          resolvedOrderId = pending ? parseInt(pending) : null;
          if (resolvedOrderId) console.log(`🔍 order_id Redis se mila: ${resolvedOrderId} (driver ${driverId})`);
        }

        console.log(`✅ Accept received: order=${resolvedOrderId} driver=${driverId}`);

        stopDispatch(resolvedOrderId).catch(() => { });
        setDriverBusy(driverId).catch(() => { });
        redis.del(`driver:pending_order:${driverId}`).catch(() => { });

        try {
          // Order fetch karo
          const order = await Order.findOne({
            where: { id: resolvedOrderId },
            attributes: ['id', 'customer_id', 'start_address', 'end_address', 'start_coordinate', 'end_coordinate', 'distance', 'payment_method', 'estimated_time', 'actual_time', 'total', 'pending_amount'],
          });

          if (!order) {
            console.error(`Accept: Order ${orderID} not found`);
            return;
          }

          // DB update — driver assign + status accepted
          await Order.update({ driver_id: driverId, status: 1 }, { where: { id: resolvedOrderId } });

          const driver = await Driver.findByPk(driverId, {
            attributes: ['id', 'name', 'image', 'Latitude', 'Longitude', 'phone', 'plate_number', 'vehicle_name', 'car_model'],
          });

          const payload = {
            Response: 'true',
            message: 'Data Found',
            type: 'Accept',
            data: {
              id: order.id,
              start_address: order.start_address,
              end_address: order.end_address,
              start_coordinate: order.start_coordinate,
              end_coordinate: order.end_coordinate,
              distance: order.distance,
              payment_method: order.payment_method,
              estimated_time: order.estimated_time,
              actual_time: order.actual_time,
              total: order.total,
              pending_amount: order.pending_amount,
              driverID: driverId,
              name: driver?.name ?? '',
              image: driver?.image ?? '',
              Latitude: driver?.Latitude ?? '',
              Longitude: driver?.Longitude ?? '',
              phone: driver?.phone ?? '',
              plate_number: driver?.plate_number ?? '',
              vehicle_name: driver?.vehicle_name ?? '',
              car_model: driver?.car_model ?? '',
              driverRating: driver?.rating ?? '0',
            },
          };

          console.log(`✅ Emitting Accept to customer_${order.customer_id}`);
          io.to(`customer_${order.customer_id}`).emit('message', payload);

        } catch (err) {
          console.error('Accept handler error:', err.message);
        }
      }

      // ── Customer: UserBookDriver (message event ke andar aata hai) ───────────
      if (serviceType === 'UserBookDriver') {
        const { UserID, OrderID } = data;
        console.log(`🚗 UserBookDriver (via message): Customer ${UserID} joining order_${OrderID} room`);
        try {
          const order = await Order.findByPk(OrderID, { attributes: ['id', 'customer_id'] });
          if (!order) {
            socket.emit('noDriverAvailable', { order_id: OrderID, message: 'Order not found' });
            return;
          }
          socket.join(`customer_${UserID}`);
          socket.join(`order_${OrderID}`);
          console.log(`✅ Customer ${UserID} joined customer_${UserID} + order_${OrderID} rooms`);
        } catch (err) {
          console.error('❌ UserBookDriver (message) error:', err.message);
        }
      }
    });

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
        await driverOffline(driverId).catch(() => { });
        lastMysqlSync.delete(driverId);
        io.emit('driver_offline', { driver_id: driverId });
        console.log(`Driver ${driverId} disconnected — waiting 30s before marking offline`);

        // MySQL mein 30s grace period ke baad offline karo
        // Agar driver 30s mein reconnect kare toh join_driver timer cancel karega
        const driverIdStr = String(driverId);
        // Redis flag clear karo — driver abhi disconnect hua
        await redis.del(`driver:connected:${driverIdStr}`).catch(() => { });

        const timer = setTimeout(async () => {
          offlineTimers.delete(driverIdStr);
          // Redis mein check karo — kisi bhi process mein reconnect hua kya?
          const isReconnected = await redis.get(`driver:connected:${driverIdStr}`).catch(() => null);
          if (isReconnected) {
            console.log(`Driver ${driverId} already reconnected (Redis flag) — skip offline mark`);
            return;
          }
          try {
            await Driver.update({ order_status: 'offline' }, { where: { id: driverId } });
            console.log(`Driver ${driverId} is now offline (grace period expired)`);
          } catch (e) {
            console.error('Offline sync error:', e.message);
          }
        }, 30000);

        offlineTimers.set(driverIdStr, timer);
      }
    });
  });
}

module.exports = setupSocket;
module.exports.offlineTimers = offlineTimers;