/**
 * Bug Condition Exploration Test — Property 1
 *
 * Validates: Requirements 1.1, 1.2, 1.3
 *
 * GOAL: Surface counterexamples that demonstrate that every incoming HTTP request
 * crashes with a TypeError before reaching any route handler.
 *
 * BUG CONDITION: isBugCondition(X) = true for ALL incoming HTTP requests.
 * express-mongo-sanitize v2.x unconditionally attempts `req['query'] = target`
 * on every request. In Express 5, req.query is a read-only getter on the
 * IncomingMessage prototype, so this assignment throws:
 *   TypeError: Cannot set property query of #<IncomingMessage> which has only a getter
 *
 * UNFIXED CODE BEHAVIOUR (documented counterexamples):
 *   - GET /              → 500 TypeError (expected: 200)
 *   - GET /?foo=bar      → 500 TypeError (expected: 200)
 *   - POST /api/auth/login with body → 500 TypeError (expected: 400/401)
 *   - GET /?$where=1     → 500 TypeError (expected: 200/404 after sanitization)
 *
 * EXPECTED OUTCOME ON UNFIXED CODE: ALL tests FAIL (all requests return 500).
 * EXPECTED OUTCOME ON FIXED CODE:   ALL tests PASS (requests return expected status).
 *
 * CRITICAL: This test is EXPECTED TO FAIL on unfixed code.
 * Failure confirms the bug exists. DO NOT fix the code when this test fails.
 */

'use strict';

const request = require('supertest');

// Mock external services so the app can be loaded without live connections
jest.mock('../config/db', () => ({ connectDB: jest.fn() }));
jest.mock('../config/redis', () => ({
  get: jest.fn(),
  set: jest.fn(),
  del: jest.fn(),
  keys: jest.fn().mockResolvedValue([]),
}));
jest.mock('../config/rabbitmq', () => ({
  publishMessage: jest.fn().mockResolvedValue(undefined),
  getChannel: jest.fn(),
}));
jest.mock('../models/User', () => ({
  findOne: jest.fn().mockResolvedValue(null),
  find: jest.fn().mockResolvedValue([]),
  create: jest.fn(),
}));

const app = require('../index');

// ── Test 1: GET with no query string ─────────────────────────────────────────

/**
 * Property 1: Bug Condition — GET / (no query string)
 * On unfixed code: returns 500 with TypeError.
 * On fixed code:   returns 200 with API info.
 *
 * Validates: Requirements 1.1, 1.3
 */
describe('Bug Condition — GET / (no query string)', () => {
  test('GET / should return 200, not 500 TypeError', async () => {
    const response = await request(app).get('/');

    // Assert: must not be a 500 caused by the TypeError
    expect(response.status).not.toBe(500);
    // Assert: no TypeError message in response body
    if (response.body && response.body.message) {
      expect(response.body.message).not.toMatch(/Cannot set property query/i);
    }
    // Expected status on fixed code
    expect(response.status).toBe(200);
  });
});

// ── Test 2: GET with benign query string ─────────────────────────────────────

/**
 * Property 1: Bug Condition — GET /?foo=bar (benign query string)
 * On unfixed code: returns 500 with TypeError.
 * On fixed code:   returns 200.
 *
 * Validates: Requirements 1.1, 1.3
 */
describe('Bug Condition — GET /?foo=bar (benign query string)', () => {
  test('GET /?foo=bar should return 200, not 500 TypeError', async () => {
    const response = await request(app).get('/?foo=bar');

    expect(response.status).not.toBe(500);
    if (response.body && response.body.message) {
      expect(response.body.message).not.toMatch(/Cannot set property query/i);
    }
    expect(response.status).toBe(200);
  });
});

// ── Test 3: POST with JSON body ───────────────────────────────────────────────

/**
 * Property 1: Bug Condition — POST /api/auth/login with JSON body
 * On unfixed code: returns 500 with TypeError (never reaches route handler).
 * On fixed code:   returns 400 (validation error) or 401 (bad credentials).
 *
 * Validates: Requirements 1.1, 1.2, 1.3
 */
describe('Bug Condition — POST /api/auth/login (JSON body)', () => {
  test('POST /api/auth/login should return 400 or 401, not 500 TypeError', async () => {
    const response = await request(app)
      .post('/api/auth/login')
      .send({ email: 'a@b.com', password: 'x' })
      .set('Content-Type', 'application/json');

    expect(response.status).not.toBe(500);
    if (response.body && response.body.message) {
      expect(response.body.message).not.toMatch(/Cannot set property query/i);
    }
    // Route handler should return 400 (validation) or 401 (bad credentials)
    expect([400, 401]).toContain(response.status);
  });
});

// ── Test 4: GET with malicious query string ───────────────────────────────────

/**
 * Property 1: Bug Condition — GET /?$where=1 (MongoDB operator in query)
 * On unfixed code: returns 500 with TypeError (crashes before sanitization).
 * On fixed code:   $where is stripped by express-mongo-sanitize, returns 200/404.
 *
 * Validates: Requirements 1.1, 1.2, 1.3
 */
describe('Bug Condition — GET /?$where=1 (malicious query string)', () => {
  test('GET /?$where=1 should be sanitized and return 200 or 404, not 500 TypeError', async () => {
    const response = await request(app).get('/?$where=1');

    expect(response.status).not.toBe(500);
    if (response.body && response.body.message) {
      expect(response.body.message).not.toMatch(/Cannot set property query/i);
    }
    // After sanitization, the route should respond normally (200 home or 404)
    expect([200, 404]).toContain(response.status);
  });
});
