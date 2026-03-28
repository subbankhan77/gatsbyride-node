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

const app = express();
app.set('trust proxy', 1); // Nginx reverse proxy ke liye
const server = http.createServer(app);

// ─── Socket.io Setup ──────────────────────────────────────────────────────────
const io = new Server(server, {
  cors: {
    origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : '*',
    methods: ['GET', 'POST'],
  },
});

// Redis adapter — multiple PM2 instances ke beech Socket.io sync karo
const { pubClient, subClient } = createPubSubClients();
Promise.all([pubClient.connect?.() ?? Promise.resolve(), subClient.connect?.() ?? Promise.resolve()])
  .then(() => {
    io.adapter(createAdapter(pubClient, subClient));
    console.log('✅ Socket.io Redis adapter ready');
  })
  .catch((err) => console.error('❌ Redis adapter error:', err.message));

setupSocket(io);

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(helmet());                          // Security headers
app.use(morgan('combined'));                // Request logging
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
}));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// Serve uploaded files
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

// Attach io to every request (so controllers can emit events)
app.use((req, res, next) => {
  req.io = io;
  next();
}); 

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use('/api/webservice', routes);
app.use('/api/admin', adminRoutes);

// Health check
app.get('/health', (req, res) => res.json({ status: 'OK', message: 'GatsbyRide API is running' }));

// 404 handler
app.use((req, res) => {
  res.status(404).json({ status: false, message: 'Route not found' });
});

// Error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ status: false, message: err.message || 'Internal server error' });
});

// ─── Database + Server Start ──────────────────────────────────────────────────
const PORT = process.env.PORT || 8000;

sequelize
  .authenticate()
  .then(() => {
    console.log('✅ Database connected successfully');
    server.listen(PORT, () => {
      console.log(`🚀 Server running on http://localhost:${PORT}`);
      console.log(`🔌 Socket.io ready`);
    });
  })
  .catch((err) => {
    console.error('❌ Database connection failed:', err.message);
    process.exit(1);
  });
