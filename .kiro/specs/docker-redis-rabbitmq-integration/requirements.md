# Requirements Document

## Introduction

This feature integrates Docker, Redis, and RabbitMQ into the existing ShopNest Node.js/Express + MongoDB e-commerce backend. The goal is to containerize all services via Docker Compose, add Redis-based caching for product listings, order lists, user lists, analytics, and payment deduplication, implement Redis-backed rate limiting on auth endpoints, and introduce RabbitMQ for asynchronous messaging (order events, email notifications, low-stock alerts, payment audit events, and analytics invalidation). All integrations must be additive — no existing controller, route, model, or middleware logic may be broken or removed.

## Glossary

- **ShopNest_API**: The existing Node.js/Express backend application located in `backend/`.
- **Docker_Compose**: The multi-container orchestration tool used to define and run all services together.
- **Redis_Client**: The Redis connection module (`backend/config/redis.js`) responsible for connecting to the Redis service.
- **Cache_Layer**: The Redis-backed caching utility that stores and retrieves serialized JSON responses.
- **RabbitMQ_Client**: The RabbitMQ connection module (`backend/config/rabbitmq.js`) responsible for establishing a channel to the message broker.
- **Message_Publisher**: The utility that publishes messages to a named RabbitMQ exchange or queue.
- **Message_Consumer**: The background worker that subscribes to a RabbitMQ queue and processes incoming messages.
- **Order_Event**: A JSON message published to RabbitMQ when an order is created or its status is updated.
- **Email_Worker**: The Message_Consumer that reads Order_Events from RabbitMQ and sends transactional emails via the existing `sendEmail` utility.
- **Cache_Key**: A deterministic string identifier used to store and retrieve a cached value in Redis.
- **TTL**: Time-to-live; the duration in seconds after which a cached entry is automatically evicted from Redis.
- **Rate_Limiter**: A Redis-backed middleware that tracks request counts per IP using a sliding window algorithm to enforce request rate limits.
- **Analytics_Cache**: The Redis cache entry storing the aggregated admin statistics response under the key `analytics:stats`.
- **User_List_Cache**: The Redis cache entry storing the full user list under the key `users:all`.
- **Orders_Cache**: The Redis cache entries storing order lists, keyed by `orders:all` for the admin view and `orders:user:{userId}` for per-user views.
- **Payment_Dedup_Cache**: The Redis cache entry that maps a payment fingerprint to an existing Razorpay order ID to prevent duplicate order creation.
- **Welcome_Worker**: The Message_Consumer that reads user registration events from the `user.registered` queue and sends welcome/OTP emails asynchronously.
- **Status_Notification_Worker**: The Message_Consumer that reads order status update events from the `order.updated` queue and sends status change emails to customers.
- **Low_Stock_Worker**: The Message_Consumer that reads `product.low_stock` events and logs or alerts administrators about out-of-stock products.
- **Payment_Audit_Worker**: The Message_Consumer that reads `payment.verified` events and records payment audit log entries.
- **Analytics_Invalidation_Worker**: The Message_Consumer that reads `analytics.invalidate` events and deletes the `analytics:stats` Cache_Key from Redis.

---

## Requirements

### Requirement 1: Docker Compose Service Orchestration

**User Story:** As a developer, I want all ShopNest services defined in a single Docker Compose file, so that I can start the entire stack with one command without manually configuring each service.

#### Acceptance Criteria

1. THE Docker_Compose SHALL define services for `app` (ShopNest_API), `mongo`, `redis`, and `rabbitmq`.
2. WHEN `docker compose up` is executed, THE Docker_Compose SHALL start all four services and make the ShopNest_API reachable on the configured `PORT`.
3. THE Docker_Compose SHALL mount a named volume for the `mongo` service so that database data persists across container restarts.
4. THE Docker_Compose SHALL mount a named volume for the `redis` service so that cache data persists across container restarts.
5. THE Docker_Compose SHALL configure the `app` service to depend on `mongo`, `redis`, and `rabbitmq` services being healthy before starting.
6. THE Docker_Compose SHALL expose the `rabbitmq` management UI on port `15672`.
7. WHERE a `.env` file is present in `backend/`, THE Docker_Compose SHALL load environment variables from it into the `app` service.
8. THE `app` service Dockerfile SHALL use a Node.js LTS base image and install only production dependencies when `NODE_ENV=production`.

---

### Requirement 2: Redis Connection and Graceful Degradation

**User Story:** As a developer, I want a Redis connection module that connects on startup and degrades gracefully on failure, so that the API continues to function even when Redis is unavailable.

#### Acceptance Criteria

1. THE Redis_Client SHALL establish a connection to the Redis service using the `REDIS_URL` environment variable on application startup.
2. WHEN the Redis service is unreachable, THE Redis_Client SHALL log a warning and allow the ShopNest_API to continue operating without caching.
3. WHEN the Redis connection is successfully established, THE Redis_Client SHALL log a confirmation message to the console.
4. THE Redis_Client SHALL export a single client instance for use across the application.
5. IF the `REDIS_URL` environment variable is not set, THEN THE Redis_Client SHALL default to `redis://localhost:6379`.

---

### Requirement 3: Product Listing Cache

**User Story:** As a developer, I want product listing responses cached in Redis, so that repeated requests for the same data are served faster without hitting MongoDB.

#### Acceptance Criteria

1. WHEN a `GET /api/products` request is received and a valid cache entry exists, THE Cache_Layer SHALL return the cached response without querying MongoDB.
2. WHEN a `GET /api/products` request is received and no cache entry exists, THE Cache_Layer SHALL fetch products from MongoDB, store the result in Redis with a TTL of 300 seconds, and return the response.
3. WHEN a product is created, updated, or deleted, THE Cache_Layer SHALL invalidate the `products:all` Cache_Key so subsequent reads reflect the latest data.
4. THE Cache_Layer SHALL serialize product data as JSON before storing it in Redis and deserialize it before returning it to the client.
5. IF the Redis_Client is unavailable during a cache read, THEN THE Cache_Layer SHALL fall through to MongoDB and return the result without error.
6. IF the Redis_Client is unavailable during a cache write, THEN THE Cache_Layer SHALL log a warning and return the MongoDB result to the client without error.

---

### Requirement 4: Single Product Cache

**User Story:** As a developer, I want individual product responses cached in Redis, so that high-traffic product detail pages are served efficiently.

#### Acceptance Criteria

1. WHEN a `GET /api/products/:id` request is received and a valid cache entry exists for `products:{id}`, THE Cache_Layer SHALL return the cached response without querying MongoDB.
2. WHEN a `GET /api/products/:id` request is received and no cache entry exists, THE Cache_Layer SHALL fetch the product from MongoDB, store the result under `products:{id}` with a TTL of 300 seconds, and return the response.
3. WHEN a product with a given `id` is updated or deleted, THE Cache_Layer SHALL invalidate the `products:{id}` Cache_Key for that product.
4. IF the Redis_Client is unavailable, THEN THE Cache_Layer SHALL fall through to MongoDB without returning an error to the client.

---

### Requirement 5: RabbitMQ Connection and Graceful Degradation

**User Story:** As a developer, I want a RabbitMQ connection module that connects on startup and degrades gracefully on failure, so that the API continues to function even when RabbitMQ is unavailable.

#### Acceptance Criteria

1. THE RabbitMQ_Client SHALL establish a connection and channel to the RabbitMQ service using the `RABBITMQ_URL` environment variable on application startup.
2. WHEN the RabbitMQ service is unreachable, THE RabbitMQ_Client SHALL log a warning and allow the ShopNest_API to continue operating without message publishing.
3. WHEN the RabbitMQ connection is successfully established, THE RabbitMQ_Client SHALL log a confirmation message to the console.
4. THE RabbitMQ_Client SHALL export functions to get the active channel and to publish messages.
5. IF the `RABBITMQ_URL` environment variable is not set, THEN THE RabbitMQ_Client SHALL default to `amqp://localhost`.

---

### Requirement 6: Order Created Event Publishing

**User Story:** As a developer, I want an Order_Event published to RabbitMQ when a new order is placed, so that downstream consumers can react asynchronously without blocking the HTTP response.

#### Acceptance Criteria

1. WHEN a new order is successfully saved to MongoDB, THE Message_Publisher SHALL publish an Order_Event to the `order.created` queue containing the order ID, user email, user name, total amount, and shipping address.
2. THE Message_Publisher SHALL publish the Order_Event as a persistent, durable message so it survives a RabbitMQ restart.
3. IF the RabbitMQ_Client channel is unavailable when publishing, THEN THE Message_Publisher SHALL log a warning and allow the order creation HTTP response to complete successfully without error.
4. THE existing `sendEmail` call inside `addOrderItems` SHALL be removed and replaced by the Message_Publisher so that email sending is fully asynchronous.

---

### Requirement 7: Order Status Updated Event Publishing

**User Story:** As a developer, I want an Order_Event published to RabbitMQ when an order status is updated, so that customers can be notified asynchronously.

#### Acceptance Criteria

1. WHEN an order status is successfully updated in MongoDB, THE Message_Publisher SHALL publish an Order_Event to the `order.updated` queue containing the order ID, new status, and user ID.
2. IF the RabbitMQ_Client channel is unavailable when publishing, THEN THE Message_Publisher SHALL log a warning and allow the status update HTTP response to complete successfully without error.

---

### Requirement 8: Email Worker Consumer

**User Story:** As a developer, I want an Email_Worker that consumes Order_Events from RabbitMQ and sends transactional emails, so that email delivery is decoupled from the HTTP request lifecycle.

#### Acceptance Criteria

1. WHEN the ShopNest_API starts, THE Email_Worker SHALL subscribe to the `order.created` queue and begin consuming messages.
2. WHEN an `order.created` message is received, THE Email_Worker SHALL send an order confirmation email to the customer using the existing `sendEmail` utility with the same content previously sent inline.
3. WHEN an email is sent successfully, THE Email_Worker SHALL acknowledge the message so RabbitMQ removes it from the queue.
4. IF sending the email fails, THEN THE Email_Worker SHALL negatively acknowledge the message so RabbitMQ can requeue it for retry.
5. IF the RabbitMQ_Client is unavailable when the worker starts, THEN THE Email_Worker SHALL log a warning and skip consumer registration without crashing the application.

---

### Requirement 9: Environment Variable Configuration

**User Story:** As a developer, I want all new service connection strings defined as environment variables with documented defaults, so that the application is portable across environments.

#### Acceptance Criteria

1. THE ShopNest_API SHALL read `REDIS_URL` from the environment to configure the Redis_Client connection.
2. THE ShopNest_API SHALL read `RABBITMQ_URL` from the environment to configure the RabbitMQ_Client connection.
3. THE `.env.example` file SHALL include `REDIS_URL` and `RABBITMQ_URL` with example values.
4. THE Docker_Compose SHALL set `REDIS_URL=redis://redis:6379` and `RABBITMQ_URL=amqp://rabbitmq` for the `app` service so that service names resolve correctly within the Docker network.

---

### Requirement 10: No Breaking Changes to Existing Code

**User Story:** As a developer, I want all new integrations to be purely additive, so that existing API endpoints, models, middleware, and routes continue to work exactly as before.

#### Acceptance Criteria

1. THE ShopNest_API SHALL preserve all existing route paths, HTTP methods, request bodies, and response shapes defined before this integration.
2. WHILE Redis is unavailable, THE ShopNest_API SHALL serve all endpoints using MongoDB as the data source with no change in response format.
3. WHILE RabbitMQ is unavailable, THE ShopNest_API SHALL complete all order creation and status update requests successfully and return the correct HTTP responses.
4. THE ShopNest_API SHALL not modify any existing model schema in `backend/models/`.
5. THE ShopNest_API SHALL not modify any existing middleware in `backend/middleware/`.

---

### Requirement 11: Analytics Stats Cache

**User Story:** As a developer, I want the admin analytics stats response cached in Redis, so that repeated calls to the expensive multi-collection aggregation endpoint are served instantly without re-querying MongoDB.

#### Acceptance Criteria

1. WHEN a `GET /api/analytics/stats` request is received and a valid cache entry exists under `analytics:stats`, THE Analytics_Cache SHALL return the cached response without querying MongoDB.
2. WHEN a `GET /api/analytics/stats` request is received and no cache entry exists, THE Cache_Layer SHALL execute all MongoDB aggregations, store the result under `analytics:stats` with a TTL of 60 seconds, and return the response.
3. WHEN an order is created or updated, THE Cache_Layer SHALL delete the `analytics:stats` Cache_Key so the next request reflects updated totals.
4. WHEN a product is created, updated, or deleted, THE Cache_Layer SHALL delete the `analytics:stats` Cache_Key so the next request reflects updated product counts.
5. IF the Redis_Client is unavailable during a cache read, THEN THE Cache_Layer SHALL fall through to MongoDB and return the aggregated result without error.
6. IF the Redis_Client is unavailable during a cache write, THEN THE Cache_Layer SHALL log a warning and return the MongoDB result to the client without error.

---

### Requirement 12: User List Cache

**User Story:** As an admin, I want the user list response cached in Redis, so that the admin user management page loads quickly without repeatedly querying MongoDB for the full user collection.

#### Acceptance Criteria

1. WHEN a `GET /api/auth/users` request is received and a valid cache entry exists under `users:all`, THE User_List_Cache SHALL return the cached response without querying MongoDB.
2. WHEN a `GET /api/auth/users` request is received and no cache entry exists, THE Cache_Layer SHALL fetch all users from MongoDB, store the result under `users:all` with a TTL of 120 seconds, and return the response.
3. WHEN a new user is successfully registered, THE Cache_Layer SHALL delete the `users:all` Cache_Key so the next admin request reflects the new user.
4. THE Cache_Layer SHALL serialize the user list as JSON before storing it in Redis and deserialize it before returning it to the client.
5. IF the Redis_Client is unavailable, THEN THE Cache_Layer SHALL fall through to MongoDB without returning an error to the client.

---

### Requirement 13: Per-User My Orders Cache

**User Story:** As a customer, I want my order history served from cache, so that the my-orders page loads quickly on repeated visits without hitting MongoDB each time.

#### Acceptance Criteria

1. WHEN a `GET /api/orders/myorders` request is received and a valid cache entry exists under `orders:user:{userId}`, THE Orders_Cache SHALL return the cached response without querying MongoDB.
2. WHEN a `GET /api/orders/myorders` request is received and no cache entry exists, THE Cache_Layer SHALL fetch the user's orders from MongoDB, store the result under `orders:user:{userId}` with a TTL of 120 seconds, and return the response.
3. WHEN a new order is placed by a user, THE Cache_Layer SHALL delete the `orders:user:{userId}` Cache_Key for that user so the next request reflects the new order.
4. WHEN an order status is updated, THE Cache_Layer SHALL delete the `orders:user:{userId}` Cache_Key for the order's owner so the next request reflects the updated status.
5. IF the Redis_Client is unavailable, THEN THE Cache_Layer SHALL fall through to MongoDB without returning an error to the client.

---

### Requirement 14: All Orders Admin Cache

**User Story:** As an admin, I want the full order list cached in Redis, so that the admin orders dashboard loads quickly without re-querying MongoDB on every page visit.

#### Acceptance Criteria

1. WHEN a `GET /api/orders` request is received and a valid cache entry exists under `orders:all`, THE Orders_Cache SHALL return the cached response without querying MongoDB.
2. WHEN a `GET /api/orders` request is received and no cache entry exists, THE Cache_Layer SHALL fetch all orders from MongoDB with user population, store the result under `orders:all` with a TTL of 60 seconds, and return the response.
3. WHEN any order is created, THE Cache_Layer SHALL delete the `orders:all` Cache_Key so the next admin request reflects the new order.
4. WHEN any order status is updated, THE Cache_Layer SHALL delete the `orders:all` Cache_Key so the next admin request reflects the updated status.
5. IF the Redis_Client is unavailable, THEN THE Cache_Layer SHALL fall through to MongoDB without returning an error to the client.

---

### Requirement 15: Redis-Backed Auth Rate Limiting

**User Story:** As a security engineer, I want a sliding window rate limiter on authentication endpoints, so that brute-force login and registration attempts are blocked before they can compromise user accounts.

#### Acceptance Criteria

1. THE Rate_Limiter SHALL track the number of requests per IP address for `POST /api/auth/login` and `POST /api/auth/register` using Redis keys with a sliding window of 900 seconds (15 minutes).
2. WHEN a request arrives and the request count for that IP is below 10 within the current window, THE Rate_Limiter SHALL increment the counter and allow the request to proceed.
3. WHEN a request arrives and the request count for that IP has reached or exceeded 10 within the current window, THE Rate_Limiter SHALL return HTTP 429 with a JSON body `{ "message": "Too many requests, please try again later." }` and SHALL NOT forward the request to the controller.
4. THE Rate_Limiter SHALL set the Redis key TTL to 900 seconds on first creation so that the window resets automatically.
5. IF the Redis_Client is unavailable when the Rate_Limiter attempts to read or write the counter, THEN THE Rate_Limiter SHALL allow the request to proceed and log a warning so that Redis downtime does not block legitimate users.
6. THE Rate_Limiter SHALL be implemented as Express middleware applied only to the auth routes, leaving all other routes unaffected.

---

### Requirement 16: Payment Order ID Deduplication Cache

**User Story:** As a developer, I want Razorpay order IDs cached in Redis, so that duplicate payment order creation requests for the same amount within a short window are prevented and the existing order ID is returned instead.

#### Acceptance Criteria

1. WHEN `POST /api/payment/create-order` is received, THE Payment_Dedup_Cache SHALL compute a Cache_Key of the form `payment:dedup:{userId}:{amountInPaise}`.
2. WHEN a valid cache entry exists for the computed Cache_Key, THE Cache_Layer SHALL return the cached Razorpay order object without calling the Razorpay API.
3. WHEN no cache entry exists, THE Cache_Layer SHALL call the Razorpay API to create the order, store the returned order object under the computed Cache_Key with a TTL of 600 seconds, and return the response.
4. IF the Redis_Client is unavailable, THEN THE Cache_Layer SHALL fall through to the Razorpay API call without returning an error to the client.

---

### Requirement 17: Welcome Email Worker via RabbitMQ

**User Story:** As a developer, I want the welcome and OTP email sent on registration to be dispatched asynchronously via RabbitMQ, so that the registration HTTP response is not delayed by email delivery.

#### Acceptance Criteria

1. WHEN a new user is successfully saved to MongoDB during registration, THE Message_Publisher SHALL publish a message to the `user.registered` queue containing the user's name, email address, and a newly generated six-digit OTP.
2. THE Message_Publisher SHALL publish the message as a persistent, durable message so it survives a RabbitMQ restart.
3. IF the RabbitMQ_Client channel is unavailable when publishing, THEN THE Message_Publisher SHALL log a warning and allow the registration HTTP response to complete successfully without error.
4. THE existing inline `sendEmail` call inside `registerUser` SHALL be removed and replaced by the Message_Publisher so that email sending is fully asynchronous.
5. WHEN the ShopNest_API starts, THE Welcome_Worker SHALL subscribe to the `user.registered` queue and begin consuming messages.
6. WHEN a `user.registered` message is received, THE Welcome_Worker SHALL send the welcome and OTP email using the existing `sendEmail` utility with the same subject and HTML content previously sent inline.
7. WHEN the email is sent successfully, THE Welcome_Worker SHALL acknowledge the message so RabbitMQ removes it from the queue.
8. IF sending the email fails, THEN THE Welcome_Worker SHALL negatively acknowledge the message so RabbitMQ can requeue it for retry.

---

### Requirement 18: Order Status Change Notification Worker

**User Story:** As a customer, I want to receive an email when my order status changes, so that I am kept informed about the progress of my shipment without having to check the app manually.

#### Acceptance Criteria

1. WHEN the ShopNest_API starts, THE Status_Notification_Worker SHALL subscribe to the `order.updated` queue and begin consuming messages.
2. WHEN an `order.updated` message is received, THE Status_Notification_Worker SHALL look up the customer's email address using the user ID contained in the message.
3. WHEN the customer email is resolved, THE Status_Notification_Worker SHALL send a status update email using the existing `sendEmail` utility informing the customer of the new order status and the order ID.
4. WHEN the email is sent successfully, THE Status_Notification_Worker SHALL acknowledge the message so RabbitMQ removes it from the queue.
5. IF sending the email fails, THEN THE Status_Notification_Worker SHALL negatively acknowledge the message so RabbitMQ can requeue it for retry.
6. IF the RabbitMQ_Client is unavailable when the worker starts, THEN THE Status_Notification_Worker SHALL log a warning and skip consumer registration without crashing the application.

---

### Requirement 19: Low Stock Alert Event

**User Story:** As an admin, I want to be alerted when a product goes out of stock after an order is placed, so that I can restock inventory before customers encounter unavailable items.

#### Acceptance Criteria

1. WHEN a new order is successfully saved to MongoDB, THE Message_Publisher SHALL check the stock level of each ordered product by querying the Product model.
2. WHEN a product's stock level is 0 or below after the order is saved, THE Message_Publisher SHALL publish a message to the `product.low_stock` queue containing the product ID, product name, and current stock level.
3. THE Message_Publisher SHALL publish the low-stock message as a persistent, durable message so it survives a RabbitMQ restart.
4. IF the RabbitMQ_Client channel is unavailable when publishing, THEN THE Message_Publisher SHALL log a warning and allow the order creation HTTP response to complete successfully without error.
5. WHEN the ShopNest_API starts, THE Low_Stock_Worker SHALL subscribe to the `product.low_stock` queue and begin consuming messages.
6. WHEN a `product.low_stock` message is received, THE Low_Stock_Worker SHALL log a structured warning message containing the product ID, product name, and stock level so that administrators can identify and act on the alert.
7. WHEN the message is processed, THE Low_Stock_Worker SHALL acknowledge it so RabbitMQ removes it from the queue.

---

### Requirement 20: Payment Verified Event Publishing

**User Story:** As a developer, I want a payment verification event published to RabbitMQ when a Razorpay payment is successfully verified, so that downstream services can perform audit logging or trigger fulfillment workflows asynchronously.

#### Acceptance Criteria

1. WHEN `verifyPayment` confirms that the Razorpay signature is valid, THE Message_Publisher SHALL publish a message to the `payment.verified` queue containing the `razorpay_order_id`, `razorpay_payment_id`, and the timestamp of verification.
2. THE Message_Publisher SHALL publish the message as a persistent, durable message so it survives a RabbitMQ restart.
3. IF the RabbitMQ_Client channel is unavailable when publishing, THEN THE Message_Publisher SHALL log a warning and allow the payment verification HTTP response to complete successfully without error.
4. WHEN the ShopNest_API starts, THE Payment_Audit_Worker SHALL subscribe to the `payment.verified` queue and begin consuming messages.
5. WHEN a `payment.verified` message is received, THE Payment_Audit_Worker SHALL log a structured audit entry containing the order ID, payment ID, and timestamp.
6. WHEN the message is processed, THE Payment_Audit_Worker SHALL acknowledge it so RabbitMQ removes it from the queue.

---

### Requirement 21: Analytics Cache Invalidation via RabbitMQ

**User Story:** As a developer, I want analytics cache invalidation to happen asynchronously via RabbitMQ, so that the analytics cache is kept consistent without adding synchronous Redis calls to every order and product mutation path.

#### Acceptance Criteria

1. WHEN an order is created or its status is updated, THE Message_Publisher SHALL publish a message to the `analytics.invalidate` queue indicating the source event type (`order.created` or `order.updated`).
2. WHEN a product is created, updated, or deleted, THE Message_Publisher SHALL publish a message to the `analytics.invalidate` queue indicating the source event type (`product.created`, `product.updated`, or `product.deleted`).
3. THE Message_Publisher SHALL publish each analytics invalidation message as a persistent, durable message so it survives a RabbitMQ restart.
4. IF the RabbitMQ_Client channel is unavailable when publishing, THEN THE Message_Publisher SHALL log a warning and allow the originating HTTP response to complete successfully without error.
5. WHEN the ShopNest_API starts, THE Analytics_Invalidation_Worker SHALL subscribe to the `analytics.invalidate` queue and begin consuming messages.
6. WHEN an `analytics.invalidate` message is received, THE Analytics_Invalidation_Worker SHALL delete the `analytics:stats` Cache_Key from Redis.
7. WHEN the Cache_Key is deleted successfully, THE Analytics_Invalidation_Worker SHALL acknowledge the message so RabbitMQ removes it from the queue.
8. IF the Redis_Client is unavailable when the Analytics_Invalidation_Worker attempts to delete the key, THEN THE Analytics_Invalidation_Worker SHALL log a warning and acknowledge the message to prevent infinite requeue loops.
