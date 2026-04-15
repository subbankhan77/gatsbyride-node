require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { createAdapter } = require('@socket.io/redis-adapter');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const path = require('path');

const sequelize = require('./config/database');
const { createPubSubClients } = require('./config/redis');
const routes = require('./routes');
const adminRoutes = require('./routes/admin');
const setupSocket = require('./socket');
const { driverOnline } = require('./utils/driverLocation');
const { Driver } = require('./models');
const { apiLogger } = require('./middleware/logger');

const app = express();
app.set('trust proxy', 1);
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : '*',
    methods: ['GET', 'POST'],
  },
});

const { pubClient, subClient } = createPubSubClients();
Promise.all([pubClient.connect?.() ?? Promise.resolve(), subClient.connect?.() ?? Promise.resolve()])
  .then(() => {
    io.adapter(createAdapter(pubClient, subClient));
    console.log('✅ Socket.io Redis adapter ready');
  })
  .catch((err) => console.error('❌ Redis adapter error:', err.message));

setupSocket(io);

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "cdn.jsdelivr.net", "blob:"],
      styleSrc: ["'self'", "'unsafe-inline'", "cdn.jsdelivr.net"],
      fontSrc: ["'self'", "cdn.jsdelivr.net", "data:"],
      imgSrc: ["'self'", "data:", "blob:"],
      connectSrc: ["'self'", "blob:"],
      workerSrc: ["'self'", "blob:"],
    },
  },
}));
app.use(morgan('combined'));
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
}));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

app.use('/admin', express.static(path.join(__dirname, '../public/admin')));
app.get('/admin/en', (req, res) => res.redirect('/admin/en/'));
app.get('/admin', (req, res) => res.redirect('/admin/en/'));

const BLOCKED_PATTERNS = [
  /\.php$/i,
  /wp-content/i,
  /wp-admin/i,
  /wp-includes/i,
  /\.env$/i,
  /\/etc\/passwd/i,
  /shell/i,
  /r00t/i,
  /loadme/i,
];

app.use((req, res, next) => {
  const url = req.originalUrl;
  const isBlocked = BLOCKED_PATTERNS.some((pattern) => pattern.test(url));
  if (isBlocked) {
    console.warn(`🚫 Blocked suspicious request: ${req.ip} → ${url}`);
    return res.status(403).json({ status: false, message: 'Forbidden' });
  }
  next();
});

app.use((req, res, next) => {
  req.io = io;
  next();
});
app.use(apiLogger);

app.use('/api/webservice', routes);
app.use('/api/admin', adminRoutes);

app.get('/health', (req, res) => res.json({ status: 'OK', message: 'GatsbyRide API is running' }));

app.use((req, res) => {
  res.status(404).json({ status: false, message: 'Route not found' });
});

app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ status: false, message: err.message || 'Internal server error' });
});

const PORT = process.env.PORT || 8000;

sequelize
  .authenticate()
  .then(() => {
    console.log('✅ Database connected successfully');
    server.listen(PORT, async () => {
      console.log(`🚀 Server running on http://localhost:${PORT}`);
      console.log(`🔌 Socket.io ready`);

      try {
        const onlineDrivers = await Driver.findAll({
          where: { order_status: 'online', status: 1 },
          attributes: ['id', 'Latitude', 'Longitude', 'bearing', 'vehicle_category_id', 'fcm_token'],
        });
        if (onlineDrivers.length > 0) {
          await Promise.all(onlineDrivers.map((d) =>
            driverOnline(d.id, {
              latitude: d.Latitude || 0,
              longitude: d.Longitude || 0,
              bearing: d.bearing || 0,
              vehicle_category_id: d.vehicle_category_id,
              fcm_token: d.fcm_token,
            })
          ));
          console.log(`✅ Redis repopulated with ${onlineDrivers.length} online drivers`);
        }
      } catch (err) {
        console.error('❌ Redis repopulate error:', err.message);
      }
    });
  })
  .catch((err) => {
    console.error('❌ Database connection failed:', err.message);
    process.exit(1);
  });
