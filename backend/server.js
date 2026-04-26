require('dotenv').config();

// --- Startup env var validation
const REQUIRED_ENV = ['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET'];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`[Startup] Missing required env var: ${key}`);
    process.exit(1);
  }
}

const connectDB = require('./config/db');
const { connectRedis } = require('./config/redis');
const { connectRabbitMQ } = require('./config/rabbitmq');
const startWorkers = require('./workers');
const app = require('./index');

const PORT = process.env.PORT || 5000;

const start = async () => {
  // Connect to MongoDB
  await connectDB();

  // Connect to Redis (non-blocking — degrades gracefully on failure)
  await connectRedis();

  // Connect to RabbitMQ and start all workers (non-blocking)
  await connectRabbitMQ();
  startWorkers();

  app.listen(PORT, () => {
    console.log(`[Server] ShopNest API running on port ${PORT}`);
  });
};

start().catch((err) => {
  console.error('[Server] Failed to start:', err.message);
  process.exit(1);
});
