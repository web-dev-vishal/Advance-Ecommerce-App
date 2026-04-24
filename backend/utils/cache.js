const { redisClient } = require('../config/redis');

const getCache = async (key) => {
  try {
    const data = await redisClient.get(key);
    if (!data) return null;
    return JSON.parse(data);
  } catch (err) {
    console.warn(`[Cache] Redis error on get(${key}):`, err.message);
    return null;
  }
};

const setCache = async (key, value, ttlSeconds) => {
  try {
    await redisClient.set(key, JSON.stringify(value), 'EX', ttlSeconds);
  } catch (err) {
    console.warn(`[Cache] Redis error on set(${key}):`, err.message);
  }
};

const delCache = async (...keys) => {
  try {
    if (keys.length > 0) {
      await redisClient.del(...keys);
    }
  } catch (err) {
    console.warn(`[Cache] Redis error on del(${keys.join(', ')}):`, err.message);
  }
};

module.exports = { getCache, setCache, delCache };
