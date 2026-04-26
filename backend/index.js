const express = require('express');
const dotenv = require('dotenv');
const cors = require('cors');
const helmet = require('helmet');
const mongoSanitize = require('express-mongo-sanitize');
const hpp = require('hpp');

dotenv.config();

const app = express();

// --- Security headers
app.use(helmet());

// --- CORS
const allowedOrigins = [
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  process.env.FRONTEND_URL,
].filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error(`CORS: origin ${origin} not allowed`));
  },
  credentials: true,
}));

// --- Body parsing with size limit
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true, limit: '10kb' }));

// --- NoSQL injection sanitization
app.use(mongoSanitize());

// --- HTTP parameter pollution protection
app.use(hpp());

// --- Routes
app.use('/api/auth',      require('./routes/authRoutes'));
app.use('/api/products',  require('./routes/productRoutes'));
app.use('/api/orders',    require('./routes/orderRoutes'));
app.use('/api/payment',   require('./routes/paymentRoutes'));
app.use('/api/analytics', require('./routes/analyticsRoutes'));

// --- Home route
app.get('/', (_req, res) => {
  res.json({
    name: 'ShopNest API',
    version: '1.0.0',
    status: 'online',
    timestamp: new Date().toISOString(),
    endpoints: {
      auth:      '/api/auth',
      products:  '/api/products',
      orders:    '/api/orders',
      payment:   '/api/payment',
      analytics: '/api/analytics',
    },
    docs: 'Import ShopNest_Postman_Collection.json into Postman to explore all endpoints',
  });
});

// --- 404 handler
app.use((_req, res) => {
  res.status(404).json({ status: 404, message: 'Route not found' });
});

// --- Global error handler
app.use((err, _req, res, _next) => {
  const status = err.status || 500;
  const message = process.env.NODE_ENV === 'production' && status === 500
    ? 'Internal Server Error'
    : err.message || 'Internal Server Error';
  if (status === 500) console.error('[Error]', err);
  res.status(status).json({ status, message });
});

module.exports = app;
