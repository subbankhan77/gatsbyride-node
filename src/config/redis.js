const Redis = require('ioredis');

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

const redis = new Redis(REDIS_URL, {
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  lazyConnect: false,
});

redis.on('connect', () => console.log('✅ Redis connected'));
redis.on('error', (err) => console.error('❌ Redis error:', err.message));

// Separate clients for Socket.io pub/sub (required by adapter)
const createPubSubClients = () => ({
  pubClient: new Redis(REDIS_URL),
  subClient: new Redis(REDIS_URL),
});

module.exports = { redis, createPubSubClients };
