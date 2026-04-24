# Implementation Plan: Docker, Redis & RabbitMQ Integration

## Overview

Incrementally wire Redis caching, RabbitMQ messaging, background workers, and Docker containerisation into the existing ShopNest Express/MongoDB backend. Every step is purely additive — no existing route, model, or middleware is broken.

## Tasks

- [x] 1. Install npm dependencies
  - Run `npm install ioredis amqplib` inside `backend/`
  - Verify both packages appear in `backend/package.json` dependencies
  - _Requirements: 2.1, 5.1_

- [x] 2. Create Redis and RabbitMQ config modules
  - [x] 2.1 Create `backend/config/redis.js`
    - Import `ioredis` and read `REDIS_URL` (default `redis://localhost:6379`)
    - Instantiate a single `Redis` client and attach `connect` / `error` event handlers for console logging
    - Export `{ redisClient, connectRedis }` where `connectRedis` is a non-blocking async wrapper
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 9.1_

  - [x] 2.2 Create `backend/config/rabbitmq.js`
    - Import `amqplib` and read `RABBITMQ_URL` (default `amqp://localhost`)
    - Implement `connectRabbitMQ()` — wraps `amqplib.connect` + `createChannel` in try/catch; stores connection and channel in module-level variables; logs success or warning on failure
    - Implement `getChannel()` — returns stored channel or `null`
    - Implement `publishMessage(queue, payload)` — asserts queue as `{ durable: true }`, calls `channel.sendToQueue` with `Buffer.from(JSON.stringify(payload))` and `{ persistent: true }`; if channel is `null` logs warning and returns without throwing
    - Export `{ connectRabbitMQ, getChannel, publishMessage }`
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 9.2_

- [x] 3. Create cache utility and rate limiter middleware
  - [x] 3.1 Create `backend/utils/cache.js`
    - Import `redisClient` from `backend/config/redis.js`
    - Implement `getCache(key)` — calls `redisClient.get(key)`, parses JSON, returns `null` on miss or Redis error (log `[Cache] Redis error: <message>` on error)
    - Implement `setCache(key, value, ttlSeconds)` — calls `redisClient.set(key, JSON.stringify(value), 'EX', ttlSeconds)`; logs warning on error, does not throw
    - Implement `delCache(...keys)` — calls `redisClient.del(...keys)`; logs warning on error, does not throw
    - Export `{ getCache, setCache, delCache }`
    - _Requirements: 3.4, 3.5, 3.6, 4.4_

  - [ ]* 3.2 Write property test for cache round-trip (Property 1)
    - **Property 1: Cache read round-trip**
    - Use `fast-check` to generate arbitrary JSON-serializable objects; assert `getCache(key)` after `setCache(key, val, 300)` deeply equals `val`
    - Tag: `// Feature: docker-redis-rabbitmq-integration, Property 1: Cache read round-trip`
    - **Validates: Requirements 3.1, 3.4, 4.1, 11.1, 12.1, 13.1, 14.1**

  - [ ]* 3.3 Write property test for Redis unavailability (Property 4)
    - **Property 4: Redis unavailability never breaks HTTP responses**
    - Mock `redisClient` to throw on every call; assert `getCache` returns `null`, `setCache`/`delCache` return without throwing
    - Tag: `// Feature: docker-redis-rabbitmq-integration, Property 4: Redis unavailability never breaks HTTP responses`
    - **Validates: Requirements 2.2, 3.5, 3.6, 4.4, 10.2**

  - [x] 3.4 Create `backend/middleware/rateLimiter.js`
    - Import `redisClient` from `backend/config/redis.js`
    - Implement sliding-window algorithm: key `ratelimit:{req.ip}`, `INCR` on each request, `EXPIRE 900` when result is `1`, respond `429 { message: "Too many requests, please try again later." }` when count ≥ 10, call `next()` otherwise
    - Wrap all Redis calls in try/catch; on error log `[RateLimit] Redis error: <message>` and call `next()`
    - Export the middleware function as default
    - _Requirements: 15.1, 15.2, 15.3, 15.4, 15.5, 15.6_

  - [ ]* 3.5 Write property test for rate limiter threshold (Property 10)
    - **Property 10: Rate limiter allows requests below threshold and blocks at threshold**
    - Mock `redisClient`; for counts 1–9 assert `next()` is called; for counts ≥ 10 assert `res.status(429)` is called with correct body
    - Tag: `// Feature: docker-redis-rabbitmq-integration, Property 10: Rate limiter allows requests below threshold and blocks at threshold`
    - **Validates: Requirements 15.1, 15.2, 15.3, 15.4**

- [ ] 4. Checkpoint — Ensure all tests pass, ask the user if questions arise.

- [x] 5. Update `productController.js` with caching and event publishing
  - Import `{ getCache, setCache, delCache }` from `../utils/cache`
  - Import `{ publishMessage }` from `../config/rabbitmq`
  - `getProducts`: check `products:all` cache (TTL 300 s); on miss fetch from MongoDB, set cache, return
  - `getProductById`: check `products:{id}` cache (TTL 300 s); on miss fetch, set cache, return
  - `createProduct`: after save call `delCache('products:all', 'analytics:stats')` and `publishMessage('analytics.invalidate', { source: 'product.created' })`
  - `updateProduct`: after save call `delCache('products:all', \`products:${id}\`, 'analytics:stats')` and `publishMessage('analytics.invalidate', { source: 'product.updated' })`
  - `deleteProduct`: after delete call `delCache('products:all', \`products:${id}\`, 'analytics:stats')` and `publishMessage('analytics.invalidate', { source: 'product.deleted' })`
  - _Requirements: 3.1, 3.2, 3.3, 4.1, 4.2, 4.3, 11.3, 11.4, 21.2, 21.3, 21.4_

  - [ ]* 5.1 Write property test for mutation invalidates cache keys (Property 3)
    - **Property 3: Mutation invalidates all related cache keys**
    - Mock `cache.js` helpers; for arbitrary product IDs assert `delCache` is called with `products:all`, `products:{id}`, and `analytics:stats` after any CUD operation
    - Tag: `// Feature: docker-redis-rabbitmq-integration, Property 3: Mutation invalidates all related cache keys`
    - **Validates: Requirements 3.3, 4.3, 11.3, 11.4**

- [x] 6. Update `orderController.js` with caching and event publishing
  - Import `{ getCache, setCache, delCache }` from `../utils/cache`
  - Import `{ publishMessage }` from `../config/rabbitmq`
  - Import `Product` model from `../models/Product`
  - Remove the existing inline `sendEmail` call and its import from `addOrderItems`
  - `addOrderItems`: after save call `delCache('orders:all', \`orders:user:${userId}\`, 'analytics:stats')`; publish `order.created` with `{ orderId, email, name, totalAmount, address }`; check each ordered product's stock and publish `product.low_stock` for any with stock ≤ 0; publish `analytics.invalidate` with `{ source: 'order.created' }`
  - `getMyOrders`: check `orders:user:{userId}` cache (TTL 120 s); on miss fetch, set cache, return
  - `getOrders`: check `orders:all` cache (TTL 60 s); on miss fetch with `.populate('userId', 'id name')`, set cache, return
  - `updateOrderStatus`: after save call `delCache('orders:all', \`orders:user:${order.userId}\`)`; publish `order.updated` with `{ orderId, status, userId }`; publish `analytics.invalidate` with `{ source: 'order.updated' }`
  - _Requirements: 6.1, 6.2, 6.3, 6.4, 7.1, 7.2, 11.3, 13.1, 13.2, 13.3, 13.4, 14.1, 14.2, 14.3, 14.4, 19.1, 19.2, 19.3, 19.4, 21.1, 21.3, 21.4_

  - [ ]* 6.1 Write property test for order.created payload completeness (Property 6)
    - **Property 6: Published order.created message contains all required fields**
    - Mock `publishMessage`; for arbitrary order objects assert the published payload contains `orderId`, `email`, `name`, `totalAmount`, and `address`
    - Tag: `// Feature: docker-redis-rabbitmq-integration, Property 6: Published order.created message contains all required fields`
    - **Validates: Requirements 6.1, 6.2**

  - [ ]* 6.2 Write property test for order.updated payload completeness (Property 8)
    - **Property 8: Published order.updated message contains all required fields**
    - Mock `publishMessage`; for arbitrary order + status strings assert the published payload contains `orderId`, `status`, and `userId`
    - Tag: `// Feature: docker-redis-rabbitmq-integration, Property 8: Published order.updated message contains all required fields`
    - **Validates: Requirements 7.1**

  - [ ]* 6.3 Write property test for low-stock events (Property 9)
    - **Property 9: Low-stock events published for every out-of-stock product**
    - Mock `publishMessage` and `Product.findById`; for arbitrary orders with mixed stock values assert `product.low_stock` is published iff stock ≤ 0
    - Tag: `// Feature: docker-redis-rabbitmq-integration, Property 9: Low-stock events published for every out-of-stock product`
    - **Validates: Requirements 19.1, 19.2, 19.3**

  - [ ]* 6.4 Write property test for RabbitMQ unavailability (Property 5)
    - **Property 5: RabbitMQ unavailability never breaks HTTP responses**
    - Mock `getChannel()` to return `null`; assert order creation and status update still return correct HTTP status and body
    - Tag: `// Feature: docker-redis-rabbitmq-integration, Property 5: RabbitMQ unavailability never breaks HTTP responses`
    - **Validates: Requirements 5.2, 6.3, 7.2, 10.3**

- [x] 7. Update `authController.js` with caching and event publishing
  - Import `{ getCache, setCache, delCache }` from `../utils/cache`
  - Import `{ publishMessage }` from `../config/rabbitmq`
  - Remove the existing inline `sendEmail` call and its import from `registerUser`
  - `registerUser`: after user save call `delCache('users:all')`; generate six-digit OTP (`Math.floor(100000 + Math.random() * 900000)`); publish `user.registered` with `{ name, email, otp }`
  - `getUsers`: check `users:all` cache (TTL 120 s); on miss fetch with `.select('-password')`, set cache, return
  - _Requirements: 12.1, 12.2, 12.3, 12.4, 12.5, 17.1, 17.2, 17.3, 17.4_

  - [ ]* 7.1 Write property test for user.registered payload completeness (Property 7)
    - **Property 7: Published user.registered message contains all required fields**
    - Mock `publishMessage`; for arbitrary user objects assert the published payload contains `name`, `email`, and a six-digit numeric `otp`
    - Tag: `// Feature: docker-redis-rabbitmq-integration, Property 7: Published user.registered message contains all required fields`
    - **Validates: Requirements 17.1, 17.2**

- [x] 8. Update `analyticsController.js` with caching
  - Import `{ getCache, setCache }` from `../utils/cache`
  - `getAdminStats`: check `analytics:stats` cache (TTL 60 s); on miss run all MongoDB aggregations, set cache, return
  - _Requirements: 11.1, 11.2, 11.5, 11.6_

- [x] 9. Update `paymentController.js` with dedup cache and payment.verified event
  - Import `{ getCache, setCache }` from `../utils/cache`
  - Import `{ publishMessage }` from `../config/rabbitmq`
  - `createOrder`: compute key `payment:dedup:{userId}:{amountInPaise}` where `amountInPaise = req.body.amount * 100`; return cached order on hit (TTL 600 s); on miss call Razorpay API, cache result, return
  - `verifyPayment`: after successful signature check publish `payment.verified` with `{ razorpay_order_id, razorpay_payment_id, timestamp: new Date().toISOString() }`
  - _Requirements: 16.1, 16.2, 16.3, 16.4, 20.1, 20.2, 20.3_

  - [ ]* 9.1 Write property test for payment deduplication (Property 11)
    - **Property 11: Payment deduplication cache prevents duplicate Razorpay calls**
    - Mock `getCache`/`setCache` and Razorpay instance; for arbitrary `(userId, amount)` pairs assert Razorpay `orders.create` is called only once on the second identical request
    - Tag: `// Feature: docker-redis-rabbitmq-integration, Property 11: Payment deduplication cache prevents duplicate Razorpay calls`
    - **Validates: Requirements 16.1, 16.2, 16.3**

- [ ] 10. Checkpoint — Ensure all tests pass, ask the user if questions arise.

- [x] 11. Create email and welcome workers
  - [x] 11.1 Create `backend/workers/emailWorker.js`
    - Import `{ getChannel }` from `../config/rabbitmq` and `sendEmail` from `../utils/sendEmail`
    - Export `start()`: if `getChannel()` is null log warning and return; assert `order.created` queue as `{ durable: true }`; consume with `{ noAck: false }`
    - On message: parse JSON payload `{ orderId, email, name, totalAmount, address }`; call `sendEmail` with subject `'ShopNest - Order Confirmation'` and HTML body matching the original inline template; ack on success, nack (requeue) on failure
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5_

  - [x] 11.2 Create `backend/workers/welcomeWorker.js`
    - Import `{ getChannel }` from `../config/rabbitmq` and `sendEmail` from `../utils/sendEmail`
    - Export `start()`: if `getChannel()` is null log warning and return; assert `user.registered` queue as `{ durable: true }`; consume with `{ noAck: false }`
    - On message: parse JSON payload `{ name, email, otp }`; call `sendEmail` with subject `'Welcome to ShopNest - Your OTP'` and HTML body matching the original inline template; ack on success, nack (requeue) on failure
    - _Requirements: 17.5, 17.6, 17.7, 17.8_

  - [ ]* 11.3 Write property test for email worker content (Property 13)
    - **Property 13: Email workers send correct content for any message payload**
    - Mock `getChannel` and `sendEmail`; for arbitrary `order.created` payloads assert `sendEmail` is called with the recipient email, a subject containing `"Order Confirmation"`, and a body containing `orderId` and `totalAmount`; for arbitrary `user.registered` payloads assert body contains the OTP
    - Tag: `// Feature: docker-redis-rabbitmq-integration, Property 13: Email workers send correct content for any message payload`
    - **Validates: Requirements 8.2, 17.6**

- [x] 12. Create status notification, low stock, payment audit, and analytics invalidation workers
  - [x] 12.1 Create `backend/workers/statusNotificationWorker.js`
    - Import `{ getChannel }` from `../config/rabbitmq`, `sendEmail` from `../utils/sendEmail`, and `User` model from `../models/User`
    - Export `start()`: if `getChannel()` is null log warning and return; assert `order.updated` queue as `{ durable: true }`; consume with `{ noAck: false }`
    - On message: parse `{ orderId, status, userId }`; look up user by `userId`; call `sendEmail` with status update subject and body; ack on success, nack (requeue) on failure
    - _Requirements: 18.1, 18.2, 18.3, 18.4, 18.5, 18.6_

  - [x] 12.2 Create `backend/workers/lowStockWorker.js`
    - Import `{ getChannel }` from `../config/rabbitmq`
    - Export `start()`: if `getChannel()` is null log warning and return; assert `product.low_stock` queue as `{ durable: true }`; consume with `{ noAck: false }`
    - On message: parse `{ productId, name, stock }`; log structured warning `[LowStock] { productId, name, stock }`; ack
    - _Requirements: 19.5, 19.6, 19.7_

  - [x] 12.3 Create `backend/workers/paymentAuditWorker.js`
    - Import `{ getChannel }` from `../config/rabbitmq`
    - Export `start()`: if `getChannel()` is null log warning and return; assert `payment.verified` queue as `{ durable: true }`; consume with `{ noAck: false }`
    - On message: parse `{ razorpay_order_id, razorpay_payment_id, timestamp }`; log structured audit entry `[PaymentAudit] { orderId, paymentId, timestamp }`; ack
    - _Requirements: 20.4, 20.5, 20.6_

  - [x] 12.4 Create `backend/workers/analyticsInvalidationWorker.js`
    - Import `{ getChannel }` from `../config/rabbitmq` and `{ delCache }` from `../utils/cache`
    - Export `start()`: if `getChannel()` is null log warning and return; assert `analytics.invalidate` queue as `{ durable: true }`; consume with `{ noAck: false }`
    - On message: call `delCache('analytics:stats')`; ack (even if Redis unavailable — log warning per error handling spec)
    - _Requirements: 21.5, 21.6, 21.7, 21.8_

  - [ ]* 12.5 Write property test for analytics invalidation worker (Property 12)
    - **Property 12: Analytics invalidation worker deletes analytics:stats on every message**
    - Mock `getChannel` and `delCache`; for arbitrary `analytics.invalidate` messages assert `delCache('analytics:stats')` is called and message is acked
    - Tag: `// Feature: docker-redis-rabbitmq-integration, Property 12: Analytics invalidation worker deletes analytics:stats on every message`
    - **Validates: Requirements 21.6, 21.7**

- [x] 13. Create `backend/workers/index.js`
  - Import all six worker modules (`emailWorker`, `welcomeWorker`, `statusNotificationWorker`, `lowStockWorker`, `paymentAuditWorker`, `analyticsInvalidationWorker`)
  - Export a single `startWorkers()` function that calls `start()` on each worker
  - _Requirements: 8.1, 17.5, 18.1, 19.5, 20.4, 21.5_

- [x] 14. Update `backend/server.js` to initialise Redis, RabbitMQ, and workers
  - Add imports for `connectRedis` from `./config/redis`, `connectRabbitMQ` from `./config/rabbitmq`, and `startWorkers` from `./workers`
  - After `connectDB()`, add an async IIFE that awaits `connectRedis()`, awaits `connectRabbitMQ()`, then calls `startWorkers()`
  - Keep all existing middleware and route registrations unchanged
  - _Requirements: 2.1, 5.1, 8.1, 17.5, 18.1, 19.5, 20.4, 21.5_

- [x] 15. Apply rate limiter middleware to auth routes
  - In `backend/routes/authRoutes.js`, import `rateLimiter` from `../middleware/rateLimiter`
  - Apply `rateLimiter` as middleware to `POST /register` and `POST /login` routes only
  - Leave `GET /users` unchanged
  - _Requirements: 15.1, 15.6, 10.1, 10.5_

- [ ] 16. Checkpoint — Ensure all tests pass, ask the user if questions arise.

- [x] 17. Update `backend/.env.example` and create Dockerfile
  - [x] 17.1 Update `backend/.env.example`
    - Append `REDIS_URL=redis://localhost:6379` and `RABBITMQ_URL=amqp://localhost` with inline comments
    - _Requirements: 9.3_

  - [x] 17.2 Create `backend/Dockerfile`
    - Use `FROM node:lts-alpine`
    - `WORKDIR /app`
    - `COPY package*.json ./`
    - `RUN npm ci --omit=dev`
    - `COPY . .`
    - `EXPOSE 5000`
    - `CMD ["node", "server.js"]`
    - _Requirements: 1.8_

- [x] 18. Create `docker-compose.yml` at project root
  - Define four services: `app`, `mongo`, `redis`, `rabbitmq`
  - `app`: build from `./backend`, port `5000:5000`, `env_file: ./backend/.env`, environment overrides `REDIS_URL=redis://redis:6379` and `RABBITMQ_URL=amqp://rabbitmq`, `depends_on` with `condition: service_healthy` for all three dependencies
  - `mongo`: image `mongo:7`, named volume `mongo_data:/data/db`, healthcheck using `mongosh --eval "db.adminCommand('ping')"`
  - `redis`: image `redis:7-alpine`, named volume `redis_data:/data`, healthcheck using `redis-cli ping`
  - `rabbitmq`: image `rabbitmq:3-management`, port `15672:15672`, healthcheck using `rabbitmq-diagnostics ping`
  - Declare named volumes `mongo_data` and `redis_data`
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 9.4_

- [ ] 19. Final checkpoint — Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for a faster MVP
- Each task references specific requirements for traceability
- Property tests use `fast-check` with a minimum of 100 iterations per property
- Workers are fire-and-forget: a missing RabbitMQ channel logs a warning but never crashes the server
- Redis and RabbitMQ failures degrade silently — all existing endpoints continue to work unchanged
