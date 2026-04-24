const { redisClient } = require('../config/redis');

const rateLimiter = async (req, res, next) => {
  const key = `ratelimit:${req.ip}`;
  try {
    const count = await redisClient.incr(key);
    if (count === 1) {
      await redisClient.expire(key, 900);
    }
    if (count >= 10) {
      return res.status(429).json({ message: 'Too many requests, please try again later.' });
    }
    next();
  } catch (err) {
    console.warn('[RateLimit] Redis error:', err.message);
    next();
  }
};

module.exports = rateLimiter;
