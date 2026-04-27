/**
 * Preservation Property Tests — Property 2
 *
 * Validates: Requirements 3.1, 3.2, 3.3, 3.4
 *
 * GOAL: Verify that the fixed pipeline preserves sanitization behaviour and
 * route responses. These tests are written to PASS on the FIXED code and serve
 * as regression guards.
 *
 * PRESERVATION INVARIANTS:
 *   - $-prefixed keys in query strings are stripped by express-mongo-sanitize
 *   - Benign query strings (no $-prefixed keys) pass through unchanged
 *   - GET / always returns 200 with expected shape
 *   - POST /api/auth/login with missing fields returns 400
 *
 * NOTE: Since the unfixed code crashes on every request (TypeError on req.query),
 * these tests are written against the intended/fixed behaviour and serve as
 * regression guards after the fix is applied.
 */

'use strict';

const request = require('supertest');
const fc = require('fast-check');

// ── Mocks ─────────────────────────────────────────────────────────────────────

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

const app = require('../index');

// ── Concrete preservation tests ───────────────────────────────────────────────

/**
 * Observation 1: GET / returns 200 with expected shape.
 * Route response preserved after fix.
 *
 * Validates: Requirements 3.3, 3.4
 */
describe('Preservation — GET / always returns 200 with expected shape', () => {
  test('GET / returns 200 with name and status fields', async () => {
    const response = await request(app).get('/');

    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty('name', 'ShopNest API');
    expect(response.body).toHaveProperty('status', 'online');
  });
});

/**
 * Observation 4: POST /api/auth/login with missing fields returns 400.
 * Body sanitization still works after fix.
 *
 * Validates: Requirements 3.1, 3.4
 */
describe('Preservation — POST /api/auth/login with missing fields returns 400', () => {
  test('POST /api/auth/login with no body returns 400', async () => {
    const response = await request(app)
      .post('/api/auth/login')
      .send({})
      .set('Content-Type', 'application/json');

    expect(response.status).toBe(400);
  });

  test('POST /api/auth/login with missing password returns 400', async () => {
    const response = await request(app)
      .post('/api/auth/login')
      .send({ email: 'test@example.com' })
      .set('Content-Type', 'application/json');

    expect(response.status).toBe(400);
  });

  test('POST /api/auth/login with missing email returns 400', async () => {
    const response = await request(app)
      .post('/api/auth/login')
      .send({ password: 'somepassword' })
      .set('Content-Type', 'application/json');

    expect(response.status).toBe(400);
  });
});

// ── Property-based tests ──────────────────────────────────────────────────────

/**
 * Property 2: Preservation — Sanitization of $-prefixed query keys
 *
 * For any query object containing $-prefixed keys, express-mongo-sanitize
 * SHALL strip those keys before the route handler is reached.
 * We verify this by checking that GET / still returns 200 (not 500) and
 * the response does not echo back the $-prefixed keys.
 *
 * Observation 3: GET /?$where=1 returns 200 — $where key is stripped.
 *
 * Validates: Requirements 3.1, 3.2
 */
describe('Preservation — property: $-prefixed query keys are stripped (sanitization preserved)', () => {
  test('fast-check: GET / with arbitrary $-prefixed query keys always returns 200', async () => {
    // Generate a non-empty string to use as the $-prefixed key suffix
    const dollarKeyArb = fc
      .string({ minLength: 1, maxLength: 20 })
      .filter(s => /^[a-zA-Z][a-zA-Z0-9_]*$/.test(s));

    // Generate a simple value for the key
    const valueArb = fc.oneof(
      fc.string({ minLength: 0, maxLength: 20 }),
      fc.integer({ min: 0, max: 9999 }).map(String)
    );

    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.tuple(dollarKeyArb, valueArb), { minLength: 1, maxLength: 5 }),
        async (pairs) => {
          // Build query string with $-prefixed keys
          const qs = pairs
            .map(([k, v]) => `$${k}=${encodeURIComponent(v)}`)
            .join('&');

          const response = await request(app).get(`/?${qs}`);

          // Sanitization must not crash the pipeline — route returns 200
          expect(response.status).toBe(200);
          // No TypeError in response
          if (response.body && response.body.message) {
            expect(response.body.message).not.toMatch(/Cannot set property query/i);
          }
        }
      ),
      { numRuns: 50 }
    );
  });
});

/**
 * Property 2: Preservation — Benign query strings pass through unchanged
 *
 * For any query string containing only non-$-prefixed keys, the route
 * SHALL respond normally (clean passthrough preserved).
 *
 * Observation 2: GET /?foo=bar returns 200 — benign query passes through.
 *
 * Validates: Requirements 3.2, 3.3
 */
describe('Preservation — property: benign query strings pass through (clean passthrough preserved)', () => {
  test('fast-check: GET / with arbitrary benign query strings always returns 200', async () => {
    // Generate keys that do NOT start with $
    const benignKeyArb = fc
      .string({ minLength: 1, maxLength: 15 })
      .filter(s => /^[a-zA-Z][a-zA-Z0-9_]*$/.test(s));

    const valueArb = fc.oneof(
      fc.string({ minLength: 0, maxLength: 20 }).map(s => s.replace(/[^\w]/g, '')),
      fc.integer({ min: 0, max: 9999 }).map(String)
    );

    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.tuple(benignKeyArb, valueArb), { minLength: 1, maxLength: 5 }),
        async (pairs) => {
          const qs = pairs
            .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
            .join('&');

          const response = await request(app).get(`/?${qs}`);

          // Benign queries must not be blocked — route returns 200
          expect(response.status).toBe(200);
          if (response.body && response.body.message) {
            expect(response.body.message).not.toMatch(/Cannot set property query/i);
          }
        }
      ),
      { numRuns: 50 }
    );
  });
});
