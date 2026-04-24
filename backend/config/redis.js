const Redis = require('ioredis');

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

const redisClient = new Redis(REDIS_URL, {
  lazyConnect: true,
  enableOfflineQueue: false,
});

redisClient.on('connect', () => {
  console.log('[Redis] Connected successfully');
});

redisClient.on('error', (err) => {
  console.warn('[Redis] Connection error:', err.message);
});

const connectRedis = async () => {
  try {
    await redisClient.connect();
  } catch (err) {
    console.warn('[Redis] Failed to connect:', err.message);
  }
};

module.exports = { redisClient, connectRedis };
