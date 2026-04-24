<div align="center">
  <img src="https://cdn-icons-png.flaticon.com/512/3514/3514491.png" alt="ShopNest Logo" width="80" />
  <h1>ShopNest — Backend API</h1>
  <p>A production-ready Node.js/Express e-commerce REST API with MongoDB, Redis caching, RabbitMQ async messaging, and full Docker support.</p>
</div>

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js + Express.js |
| Database | MongoDB (Mongoose) |
| Cache / Rate Limiting | Redis (ioredis) |
| Message Broker | RabbitMQ (amqplib) |
| Auth | JWT (Bearer tokens) |
| Payments | Razorpay |
| Image Uploads | Cloudinary + Multer |
| Containerisation | Docker + Docker Compose |

---

## Project Structure

```
backend/
├── config/
│   ├── db.js              # MongoDB connection
│   ├── redis.js           # Redis client (ioredis)
│   ├── rabbitmq.js        # RabbitMQ client (amqplib)
│   └── cloudinary.js      # Cloudinary config
├── controllers/           # Route handlers
├── middleware/
│   ├── authMiddleware.js  # JWT protect
│   ├── adminMiddleware.js # Admin role guard
│   └── rateLimiter.js     # Redis sliding-window rate limiter
├── models/                # Mongoose schemas
├── routes/                # Express routers
├── utils/
│   ├── cache.js           # Redis get/set/del helpers
│   └── sendEmail.js       # Nodemailer utility
├── workers/               # RabbitMQ consumers
│   ├── emailWorker.js             # order.created → confirmation email
│   ├── welcomeWorker.js           # user.registered → welcome/OTP email
│   ├── statusNotificationWorker.js # order.updated → status email
│   ├── lowStockWorker.js          # product.low_stock → admin alert log
│   ├── paymentAuditWorker.js      # payment.verified → audit log
│   ├── analyticsInvalidationWorker.js # analytics.invalidate → cache del
│   └── index.js           # Starts all workers
├── index.js               # Express app factory (routes, middleware)
├── server.js              # Entry point (DB + Redis + RabbitMQ + listen)
└── Dockerfile
docker-compose.yml
```

---

## Quick Start

### Option A — Docker (recommended)

Requires [Docker Desktop](https://www.docker.com/products/docker-desktop/).

**1. Copy and fill in your environment file:**
```bash
cp backend/.env.example backend/.env
```

Edit `backend/.env` with your real values (see [Environment Variables](#environment-variables) below).

**2. Start the full stack:**
```bash
docker compose up --build
```

This starts four services:
- `app` — ShopNest API on port `5000`
- `mongo` — MongoDB on port `27017`
- `redis` — Redis on port `6379`
- `rabbitmq` — RabbitMQ on port `5672`, management UI on `http://localhost:15672`

**3. Seed the database:**
```bash
docker compose exec app node seed.js
```

> Seed admin credentials: `admin@shopnest.com` / `password123`

---

### Option B — Local (without Docker)

Requires MongoDB, Redis, and RabbitMQ running locally.

```bash
cd backend
npm install
node seed.js      # optional — seed sample data
node server.js
```

---

## Environment Variables

Create `backend/.env` from `backend/.env.example`:

```env
PORT=5000
NODE_ENV=development

# MongoDB
MONGO_URI=mongodb://127.0.0.1:27017/shopnest

# Auth
JWT_SECRET=your_jwt_secret_key

# Cloudinary
CLOUDINARY_CLOUD_NAME=your_cloud_name
CLOUDINARY_API_KEY=your_api_key
CLOUDINARY_API_SECRET=your_api_secret

# Razorpay
RAZORPAY_KEY_ID=your_razorpay_key_id
RAZORPAY_KEY_SECRET=your_razorpay_key_secret

# Email (Gmail)
GMAIL_USER=your_email@gmail.com
GMAIL_PASS=your_app_password

# Redis
REDIS_URL=redis://localhost:6379

# RabbitMQ
RABBITMQ_URL=amqp://localhost
```

> When running via Docker Compose, `REDIS_URL` and `RABBITMQ_URL` are automatically overridden to use the container service names.

---

## API Reference

Base URL: `http://localhost:5000`

All protected routes require: `Authorization: Bearer <token>`

### Auth — `/api/auth`

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| GET | `/` | — | Health check |
| POST | `/api/auth/register` | — | Register user (rate limited) |
| POST | `/api/auth/login` | — | Login user (rate limited) |
| GET | `/api/auth/users` | Admin | Get all users |

### Products — `/api/products`

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| GET | `/api/products` | — | Get all products (cached 300s) |
| GET | `/api/products/:id` | — | Get product by ID (cached 300s) |
| POST | `/api/products` | Admin | Create product (multipart/form-data) |
| PUT | `/api/products/:id` | Admin | Update product |
| DELETE | `/api/products/:id` | Admin | Delete product |

### Orders — `/api/orders`

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| POST | `/api/orders` | User | Place an order |
| GET | `/api/orders/myorders` | User | Get my orders (cached 120s) |
| GET | `/api/orders` | Admin | Get all orders (cached 60s) |
| PUT | `/api/orders/:id/status` | Admin | Update order status (`Pending` / `Shipped` / `Delivered` / `Cancelled`) |

### Payment — `/api/payment`

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| POST | `/api/payment/order` | User | Create Razorpay order (dedup cached 600s) |
| POST | `/api/payment/verify` | User | Verify Razorpay payment signature |

### Analytics — `/api/analytics`

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| GET | `/api/analytics` | Admin | Get dashboard stats (cached 60s) |

---

## Redis Cache Keys

| Key | TTL | Description |
|---|---|---|
| `products:all` | 300s | All products list |
| `products:{id}` | 300s | Single product |
| `orders:all` | 60s | All orders (admin) |
| `orders:user:{userId}` | 120s | Per-user order history |
| `users:all` | 120s | All users (admin) |
| `analytics:stats` | 60s | Dashboard stats |
| `payment:dedup:{userId}:{amount}` | 600s | Razorpay order deduplication |
| `ratelimit:{ip}` | 900s | Auth rate limit counter |

Redis is optional — if unavailable, all endpoints fall back to MongoDB transparently.

---

## RabbitMQ Queues

| Queue | Publisher | Consumer | Purpose |
|---|---|---|---|
| `order.created` | orderController | emailWorker | Order confirmation email |
| `order.updated` | orderController | statusNotificationWorker | Status change email |
| `user.registered` | authController | welcomeWorker | Welcome + OTP email |
| `product.low_stock` | orderController | lowStockWorker | Admin low-stock alert log |
| `payment.verified` | paymentController | paymentAuditWorker | Payment audit log |
| `analytics.invalidate` | order/productController | analyticsInvalidationWorker | Invalidate analytics cache |

RabbitMQ is optional — if unavailable, all HTTP responses complete normally and events are silently skipped.

---

## Postman Collection

Import `ShopNest_Postman_Collection.json` into Postman.

Set the `endpoint` collection variable to `http://localhost:5000`. After hitting **Login User**, the `token` variable is automatically saved for all subsequent requests.

Available variables: `endpoint`, `token`, `productId`, `orderId`.
