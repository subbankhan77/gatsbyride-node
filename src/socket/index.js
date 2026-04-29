const { Driver, Customer, Order, ChatMessage } = require('../models');
const { Op } = require('sequelize');
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
    if (!token) return next(new Error('Authentication required'));
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
        console.warn(`[driver_location] Invalid lat/lng from driver ${driverId}`);
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

    socket.on('join_order', (data) => {
      const { order_id } = data;
      if (order_id) socket.join(`order_${order_id}`);
    });

    socket.on('order_status_update', async (data) => {
      const { order_id, status, driver_id, customer_id } = data;

      await Order.update({ status }, { where: { id: order_id } });

      if (status == 8) {
        stopDispatch(order_id).catch(() => {});
        if (driver_id) setDriverFree(driver_id).catch(() => {});
      }

      if (customer_id) io.to(`customer_${customer_id}`).emit('order_status_update', { order_id, status });
      if (driver_id) io.to(`driver_${driver_id}`).emit('order_status_update', { order_id, status });
      io.to(`order_${order_id}`).emit('order_status_update', { order_id, status });
    });

    socket.on('message', async (data) => {
      const { serviceType, UserID, orderID, order_id: order_id_snake } = data;
      const driverId = UserID || socket.userId;

      if (serviceType === 'Accept') {
        let resolvedOrderId = orderID || order_id_snake;
        if (!resolvedOrderId) {
          const pending = await redis.get(`driver:pending_order:${driverId}`);
          resolvedOrderId = pending ? parseInt(pending) : null;
          if (resolvedOrderId) console.log(`🔍 order_id Redis se mila: ${resolvedOrderId} (driver ${driverId})`);
        }

        console.log(`✅ Accept received: order=${resolvedOrderId} driver=${driverId}`);

        stopDispatch(resolvedOrderId).catch(() => {});
        setDriverBusy(driverId).catch(() => {});
        redis.del(`driver:pending_order:${driverId}`).catch(() => {});

        try {
          const order = await Order.findOne({
            where: { id: resolvedOrderId },
            attributes: ['id', 'customer_id', 'start_address', 'end_address', 'start_coordinate', 'end_coordinate', 'distance', 'payment_method', 'estimated_time', 'actual_time', 'total', 'pending_amount'],
          });

          if (!order) {
            console.error(`Accept: Order ${resolvedOrderId} not found`);
            return;
          }

          await Order.update({ driver_id: driverId, status: 1 }, { where: { id: resolvedOrderId } });

          const driver = await Driver.findByPk(driverId, {
            attributes: ['id', 'name', 'image', 'Latitude', 'Longitude', 'phone', 'plate_number', 'vehicle_name', 'car_model', 'rating'],
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

      if (serviceType === 'ChangeStatus') {
        const { orderID: csOrderId, Status, actualTime, StartTime, EndTime, distance } = data;

        console.log(`🔄 ChangeStatus: order=${csOrderId} status=${Status} driver=${driverId}`);

        try {
          const updateFields = { status: Status };
          if (actualTime) updateFields.actual_time = actualTime;
          if (StartTime) updateFields.start_time = StartTime || null;
          if (EndTime) updateFields.end_time = EndTime || null;
          if (distance) updateFields.actual_distance = distance;

          await Order.update(updateFields, { where: { id: csOrderId } });

          const order = await Order.findByPk(csOrderId, {
            attributes: [
              'id', 'customer_id', 'driver_id', 'total',
              'actual_distance', 'distance', 'payment_method',
              'start_address', 'end_address',
              'start_coordinate', 'end_coordinate',
            ],
          });

          if (!order) {
            console.error(`ChangeStatus: Order ${csOrderId} not found`);
            return;
          }

          const statusMap = {
            '1': 'Accept',
            '2': 'DepartToCustomer',
            '3': 'reachLocation',
            '5': 'startTrip',
            '7': 'endTrip',
            '8': 'Reject',
          };

          const eventType = statusMap[String(Status)];
          if (!eventType) {
            console.warn(`ChangeStatus: Unknown status ${Status}`);
            return;
          }

          const payload = {
            type: eventType,
            message: 'Status Updated',
            Response: 'true',
            data: {
              id: order.id,
              driverID: driverId,
              status: Status,
              start_address: order.start_address,
              end_address: order.end_address,
              start_coordinate: order.start_coordinate,
              end_coordinate: order.end_coordinate,
              payment_method: order.payment_method,
              distance: order.distance,
              total: order.total,
              actual_distance: order.actual_distance,
              new_total: order.total,
              grand_total: order.total,
              pending_amount: 0,
              estimated_time: 0,
              actual_time: actualTime || 0,
            },
          };

          if (String(Status) === '7') {
            setDriverFree(driverId).catch(() => {});
            payload.data.actual_distance = distance || order.actual_distance;
          }

          if (String(Status) === '8') {
            setDriverFree(driverId).catch(() => {});
            stopDispatch(csOrderId).catch(() => {});
          }

          io.to(`customer_${order.customer_id}`).emit('message', payload);

          console.log(`✅ ChangeStatus ${Status} (${eventType}) → customer_${order.customer_id}`);

        } catch (err) {
          console.error('ChangeStatus handler error:', err.message);
        }
      }

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

      // Chat room join — Flutter app roomID format: "driverId-customerId"
      if (serviceType === 'Join') {
        const { roomID } = data;
        if (!roomID) return;

        socket.join(roomID);
        console.log(`💬 Chat Join: ${socket.userGuard} ${socket.userId} joined room ${roomID}`);

        try {
          const [driverIdStr, customerIdStr] = String(roomID).split('-');
          const driverIdNum = parseInt(driverIdStr);
          const customerIdNum = parseInt(customerIdStr);

          // Driver-customer ke beech latest active order dhundo
          const order = await Order.findOne({
            where: {
              driver_id: driverIdNum,
              customer_id: customerIdNum,
              status: { [Op.in]: [1, 2, 3, 5, 7] },
            },
            attributes: ['id'],
            order: [['id', 'DESC']],
          });

          const messages = await ChatMessage.findAll({
            where: order ? { order_id: order.id } : { order_id: null },
            order: [['created_at', 'ASC']],
            limit: 50,
          });

          socket.emit('message', {
            type: 'MessageList',
            Response: 'true',
            data: messages,
          });

          console.log(`💬 Chat history sent: ${messages.length} messages to ${socket.userGuard} ${socket.userId}`);
        } catch (err) {
          console.error('💬 Chat Join error:', err.message);
        }
      }

      // Chat message — Flutter app data format: { serviceType, msg, room }
      if (serviceType === 'Chat') {
        const { msg, room } = data;
        if (!msg || !room) {
          console.warn('[Chat] Missing msg or room:', data);
          return;
        }

        const senderId = socket.userId;
        const senderType = socket.userGuard; // JWT se — trust karo client ko nahi

        const [driverIdStr, customerIdStr] = String(room).split('-');
        const driverIdNum = parseInt(driverIdStr);
        const customerIdNum = parseInt(customerIdStr);

        // Receiver ID determine karo
        const receiverId = senderType === 'driver' ? customerIdNum : driverIdNum;

        console.log(`💬 Chat: ${senderType} ${senderId} → room ${room} | msg: "${String(msg).substring(0, 40)}"`);

        try {
          // Active order find karo
          const order = await Order.findOne({
            where: { driver_id: driverIdNum, customer_id: customerIdNum },
            attributes: ['id'],
            order: [['id', 'DESC']],
          });

          const orderId = order?.id || null;

          // DB mein save karo
          const savedMsg = await ChatMessage.create({
            order_id: orderId,
            sender_id: senderId,
            sender_type: senderType,
            receiver_id: receiverId,
            message: msg,
          });

          const payload = {
            type: 'Chat',
            Response: 'true',
            data: {
              id: savedMsg.id,
              message: msg,
              sender_id: senderId,
              sender_type: senderType,
              order_id: orderId,
              created_at: savedMsg.created_at,
            },
          };

          // Room mein baaki sab ko forward karo (sender ko nahi)
          socket.to(room).emit('message', payload);
          console.log(`💬 Chat forwarded to room ${room}`);

          // FCM — agar receiver room mein nahi hai (offline)
          const roomSize = io.sockets.adapter.rooms.get(room)?.size || 0;
          if (roomSize <= 1) {
            const ReceiverModel = senderType === 'driver' ? Customer : Driver;
            const receiver = await ReceiverModel.findByPk(receiverId, {
              attributes: ['fcm_token'],
            }).catch(() => null);

            if (receiver?.fcm_token) {
              sendNotification(
                receiver.fcm_token,
                'New Message',
                String(msg).substring(0, 100),
                {
                  type: 'chat',
                  order_id: String(orderId || ''),
                  sender_id: String(senderId),
                  sender_type: String(senderType),
                  room: String(room),
                }
              ).catch((err) => console.error('Chat FCM error:', err.message));
              console.log(`💬 FCM sent to ${senderType === 'driver' ? 'customer' : 'driver'} ${receiverId}`);
            } else {
              console.warn(`💬 Receiver ${receiverId} has no FCM token — notification skip`);
            }
          }
        } catch (err) {
          console.error('💬 Chat handler error:', err.message);
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

    socket.on('send_message', async (data) => {
      const { message, order_id } = data;
      const senderId = socket.userId;
      const senderType = socket.userGuard; // JWT se — 'customer' ya 'driver'

      if (!order_id || !message || !senderId) {
        console.warn('[send_message] Missing required fields:', { order_id, message, senderId });
        return;
      }

      try {
        const order = await Order.findByPk(order_id, {
          attributes: ['id', 'customer_id', 'driver_id'],
        });

        if (!order) {
          console.warn(`[send_message] Order ${order_id} not found`);
          return;
        }

        // Sender ke hisaab se receiver determine karo
        let receiverId, targetRoom;
        if (senderType === 'driver') {
          receiverId = order.customer_id;
          targetRoom = `customer_${receiverId}`;
        } else {
          receiverId = order.driver_id;
          targetRoom = `driver_${receiverId}`;
        }

        if (!receiverId) {
          console.warn(`[send_message] Receiver not found for order ${order_id} (driver assigned?)`);
          return;
        }

        const msgPayload = {
          message,
          sender_id: senderId,
          sender_type: senderType,
          order_id,
          timestamp: new Date().toISOString(),
        };

        // Receiver ke room mein aur order room mein emit karo
        io.to(targetRoom).emit('receive_message', msgPayload);
        io.to(`order_${order_id}`).emit('receive_message', msgPayload);

        console.log(`[send_message] ${senderType} ${senderId} → ${targetRoom} | order ${order_id}`);

        // DB mein save karo
        ChatMessage.create({
          order_id,
          sender_id: senderId,
          sender_type: senderType,
          receiver_id: receiverId,
          message,
        }).catch((err) => console.error('Chat save error:', err.message));

        // FCM — agar receiver room mein nahi hai
        const roomSize = io.sockets.adapter.rooms.get(targetRoom)?.size || 0;
        if (roomSize === 0) {
          const ReceiverModel = senderType === 'driver' ? Customer : Driver;
          const receiver = await ReceiverModel.findByPk(receiverId, {
            attributes: ['fcm_token'],
          }).catch(() => null);

          if (receiver?.fcm_token) {
            sendNotification(
              receiver.fcm_token,
              'New Message',
              String(message).substring(0, 100),
              {
                type: 'chat',
                order_id: String(order_id),
                sender_id: String(senderId),
                sender_type: String(senderType),
              }
            ).catch((err) => console.error('Chat FCM error:', err.message));
            console.log(`[send_message] FCM sent to ${senderType === 'driver' ? 'customer' : 'driver'} ${receiverId}`);
          } else {
            console.warn(`[send_message] Receiver ${receiverId} has no FCM token`);
          }
        }
      } catch (err) {
        console.error('[send_message] Error:', err.message);
      }
    });

    socket.on('disconnect', async () => {
      console.log(`Socket disconnected: ${socket.id} | user: ${socket.userId}`);

      if (socket.userGuard === 'driver' && socket.userId) {
        const driverId = socket.userId;

        await driverOffline(driverId).catch(() => {});
        lastMysqlSync.delete(driverId);
        io.emit('driver_offline', { driver_id: driverId });
        console.log(`Driver ${driverId} disconnected — waiting 30s before marking offline`);

        const driverIdStr = String(driverId);
        await redis.del(`driver:connected:${driverIdStr}`).catch(() => {});

        const timer = setTimeout(async () => {
          offlineTimers.delete(driverIdStr);
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
