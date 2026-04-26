'use strict';

/**
 * Unit Tests — verifyPayment and createOrder edge cases
 *
 * Task 3.2: verifyPayment edge cases
 * Task 3.3: createOrder edge cases
 *
 * Validates: Requirements 2.2, 2.3, 2.4, 3.1, 3.2, 3.3, 3.4
 */

const crypto = require('crypto');

// ── Mocks ────────────────────────────────────────────────────────────────────

jest.mock('../config/rabbitmq', () => ({
  publishMessage: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../utils/cache', () => ({
  getCache: jest.fn(),
  setCache: jest.fn().mockResolvedValue(undefined),
}));

// Mock Razorpay constructor and orders.create
const mockOrdersCreate = jest.fn();
jest.mock('razorpay', () => {
  return jest.fn().mockImplementation(() => ({
    orders: { create: mockOrdersCreate },
  }));
});

// Set env vars before loading the controller
process.env.RAZORPAY_KEY_SECRET = 'test_secret_key';
process.env.RAZORPAY_KEY_ID = 'test_key_id';

const { verifyPayment, createOrder } = require('../controllers/paymentController');
const { publishMessage } = require('../config/rabbitmq');
const { getCache, setCache } = require('../utils/cache');

// ── Helpers ──────────────────────────────────────────────────────────────────

function buildReqRes(bodyOverrides = {}) {
  const result = { statusCode: null, body: null };

  const req = {
    body: {
      razorpay_order_id: 'order_test123',
      razorpay_payment_id: 'pay_test456',
      razorpay_signature: 'some_signature',
      ...bodyOverrides,
    },
  };

  const res = {
    status(code) {
      result.statusCode = code;
      return res;
    },
    json(data) {
      result.body = data;
      return res;
    },
  };

  return { req, res, result };
}

function computeValidSignature(orderId, paymentId) {
  return crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update(`${orderId}|${paymentId}`)
    .digest('hex');
}

// ── Reset mocks between tests ─────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
});

// ── Task 3.2: verifyPayment unit tests ────────────────────────────────────────

describe('verifyPayment — malformed signature edge cases', () => {
  test('razorpay_signature = "" → 400, no throw', async () => {
    const { req, res, result } = buildReqRes({ razorpay_signature: '' });

    await expect(verifyPayment(req, res)).resolves.not.toThrow();

    expect(result.statusCode).toBe(400);
  });

  test('razorpay_signature = "zz" (non-hex) → 400, no throw', async () => {
    const { req, res, result } = buildReqRes({ razorpay_signature: 'zz' });

    await expect(verifyPayment(req, res)).resolves.not.toThrow();

    expect(result.statusCode).toBe(400);
  });

  test('razorpay_signature = "abc" (odd-length) → 400, no throw', async () => {
    const { req, res, result } = buildReqRes({ razorpay_signature: 'abc' });

    await expect(verifyPayment(req, res)).resolves.not.toThrow();

    expect(result.statusCode).toBe(400);
  });
});

describe('verifyPayment — missing required fields', () => {
  test('missing razorpay_order_id → 400 with validation message', async () => {
    const { req, res, result } = buildReqRes({ razorpay_order_id: undefined });

    await verifyPayment(req, res);

    expect(result.statusCode).toBe(400);
    expect(result.body.message).toMatch(/razorpay_order_id/);
  });

  test('missing razorpay_payment_id → 400 with validation message', async () => {
    const { req, res, result } = buildReqRes({ razorpay_payment_id: undefined });

    await verifyPayment(req, res);

    expect(result.statusCode).toBe(400);
    expect(result.body.message).toMatch(/razorpay_payment_id/);
  });

  test('missing razorpay_signature → 400 with validation message', async () => {
    const { req, res, result } = buildReqRes({ razorpay_signature: undefined });

    await verifyPayment(req, res);

    expect(result.statusCode).toBe(400);
    expect(result.body.message).toMatch(/razorpay_signature/);
  });
});

describe('verifyPayment — signature matching', () => {
  test('correct HMAC-SHA256 signature → 200, publishMessage called with correct payload', async () => {
    const orderId = 'order_test123';
    const paymentId = 'pay_test456';
    const validSig = computeValidSignature(orderId, paymentId);

    const { req, res, result } = buildReqRes({
      razorpay_order_id: orderId,
      razorpay_payment_id: paymentId,
      razorpay_signature: validSig,
    });

    await verifyPayment(req, res);

    expect(result.statusCode).toBe(200);
    expect(result.body.message).toBe('Payment verified successfully');
    expect(publishMessage).toHaveBeenCalledTimes(1);
    expect(publishMessage).toHaveBeenCalledWith('payment.verified', {
      razorpay_order_id: orderId,
      razorpay_payment_id: paymentId,
      timestamp: expect.any(String),
    });
  });

  test('valid 64-char hex that does not match → 400, publishMessage not called', async () => {
    const wrongSig = 'b'.repeat(64);

    const { req, res, result } = buildReqRes({ razorpay_signature: wrongSig });

    await verifyPayment(req, res);

    expect(result.statusCode).toBe(400);
    expect(result.body.message).toBe('Invalid payment signature');
    expect(publishMessage).not.toHaveBeenCalled();
  });
});

// ── Task 3.3: createOrder unit tests ─────────────────────────────────────────

describe('createOrder — invalid amount', () => {
  test('amount = 0 → 400 "Valid amount is required"', async () => {
    const result = { statusCode: null, body: null };
    const req = { body: { amount: 0 }, user: { _id: 'user123' } };
    const res = {
      status(code) { result.statusCode = code; return res; },
      json(data) { result.body = data; return res; },
    };

    await createOrder(req, res);

    expect(result.statusCode).toBe(400);
    expect(result.body.message).toBe('Valid amount is required');
    expect(mockOrdersCreate).not.toHaveBeenCalled();
  });

  test('amount = -5 → 400 "Valid amount is required"', async () => {
    const result = { statusCode: null, body: null };
    const req = { body: { amount: -5 }, user: { _id: 'user123' } };
    const res = {
      status(code) { result.statusCode = code; return res; },
      json(data) { result.body = data; return res; },
    };

    await createOrder(req, res);

    expect(result.statusCode).toBe(400);
    expect(result.body.message).toBe('Valid amount is required');
    expect(mockOrdersCreate).not.toHaveBeenCalled();
  });
});

describe('createOrder — cache behaviour', () => {
  test('valid amount, cache hit → returns cached order, Razorpay SDK not called', async () => {
    const cachedOrder = { id: 'order_cached', amount: 50000, currency: 'INR' };
    getCache.mockResolvedValue(cachedOrder);

    const result = { statusCode: null, body: null };
    const req = { body: { amount: 500 }, user: { _id: 'user123' } };
    const res = {
      status(code) { result.statusCode = code; return res; },
      json(data) { result.body = data; return res; },
    };

    await createOrder(req, res);

    expect(result.body).toEqual(cachedOrder);
    expect(mockOrdersCreate).not.toHaveBeenCalled();
  });

  test('valid amount, cache miss → calls Razorpay SDK, caches result, returns order', async () => {
    const newOrder = { id: 'order_new', amount: 50000, currency: 'INR' };
    getCache.mockResolvedValue(null);
    mockOrdersCreate.mockResolvedValue(newOrder);

    const result = { statusCode: null, body: null };
    const req = { body: { amount: 500 }, user: { _id: 'user123' } };
    const res = {
      status(code) { result.statusCode = code; return res; },
      json(data) { result.body = data; return res; },
    };

    await createOrder(req, res);

    expect(mockOrdersCreate).toHaveBeenCalledTimes(1);
    expect(mockOrdersCreate).toHaveBeenCalledWith({ amount: 50000, currency: 'INR' });
    expect(setCache).toHaveBeenCalledWith(
      expect.stringContaining('payment:dedup:user123:50000'),
      newOrder,
      600
    );
    expect(result.body).toEqual(newOrder);
  });
});
