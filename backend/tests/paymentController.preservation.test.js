'use strict';

/**
 * Preservation Property Tests
 *
 * Validates: Requirements 2.1–2.8, 3.1–3.7, 4.1–4.6
 *
 * GOAL: Verify that well-formed requests behave correctly on the fixed code.
 * These tests PASS on the current code and confirm no regressions.
 */

const crypto = require('crypto');
const fc = require('fast-check');

// ── Mocks ────────────────────────────────────────────────────────────────────

jest.mock('../config/rabbitmq', () => ({
  publishMessage: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../utils/cache', () => ({
  getCache: jest.fn(),
  setCache: jest.fn().mockResolvedValue(undefined),
}));

const mockOrdersCreate = jest.fn();
const mockPaymentsFetch = jest.fn();
jest.mock('razorpay', () =>
  jest.fn().mockImplementation(() => ({
    orders: { create: mockOrdersCreate },
    payments: { fetch: mockPaymentsFetch },
  }))
);

const mockFindOne = jest.fn();
const mockFindByIdAndUpdate = jest.fn();
jest.mock('../models/Order', () => ({
  findOne: (...args) => mockFindOne(...args),
  findByIdAndUpdate: (...args) => mockFindByIdAndUpdate(...args),
}));

const TEST_SECRET = 'test_secret_key';
process.env.RAZORPAY_KEY_ID = 'test_key_id';
process.env.RAZORPAY_KEY_SECRET = TEST_SECRET;

const { createOrder, confirmPayment, verifyPayment } = require('../controllers/paymentController');
const { publishMessage } = require('../config/rabbitmq');
const { getCache, setCache } = require('../utils/cache');

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeRes() {
  const result = { statusCode: null, body: null };
  const res = {
    status(code) { result.statusCode = code; return res; },
    json(data) { result.body = data; return res; },
  };
  return { res, result };
}

function computeValidSignature(orderId, paymentId) {
  return crypto
    .createHmac('sha256', TEST_SECRET)
    .update(`${orderId}|${paymentId}`)
    .digest('hex');
}

beforeEach(() => jest.clearAllMocks());

// ── verifyPayment preservation ────────────────────────────────────────────────

describe('verifyPayment — missing field validation returns 400', () => {
  test('missing razorpay_order_id → 400', async () => {
    const { res, result } = makeRes();
    await verifyPayment({ body: { razorpay_payment_id: 'pay_1', razorpay_signature: 'a'.repeat(64) } }, res);
    expect(result.statusCode).toBe(400);
    expect(result.body.message).toMatch(/razorpay_order_id/);
  });

  test('missing razorpay_payment_id → 400', async () => {
    const { res, result } = makeRes();
    await verifyPayment({ body: { razorpay_order_id: 'ord_1', razorpay_signature: 'a'.repeat(64) } }, res);
    expect(result.statusCode).toBe(400);
    expect(result.body.message).toMatch(/razorpay_payment_id/);
  });

  test('missing razorpay_signature → 400', async () => {
    const { res, result } = makeRes();
    await verifyPayment({ body: { razorpay_order_id: 'ord_1', razorpay_payment_id: 'pay_1' } }, res);
    expect(result.statusCode).toBe(400);
    expect(result.body.message).toMatch(/razorpay_signature/);
  });
});

describe('verifyPayment — valid HMAC → 200, publishMessage called', () => {
  test('correctly computed HMAC returns 200 and publishes event', async () => {
    const orderId = 'order_test123';
    const paymentId = 'pay_test456';
    const sig = computeValidSignature(orderId, paymentId);

    const { res, result } = makeRes();
    await verifyPayment({ body: { razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: sig } }, res);

    expect(result.statusCode).toBe(200);
    expect(result.body.message).toBe('Payment verified successfully');
    expect(publishMessage).toHaveBeenCalledWith('payment.verified', {
      razorpay_order_id: orderId,
      razorpay_payment_id: paymentId,
      timestamp: expect.any(String),
    });
  });
});

describe('verifyPayment — valid 64-char hex that does NOT match HMAC → 400', () => {
  test('mismatched 64-char hex → 400, publishMessage not called', async () => {
    const { res, result } = makeRes();
    await verifyPayment({ body: { razorpay_order_id: 'ord_1', razorpay_payment_id: 'pay_1', razorpay_signature: 'a'.repeat(64) } }, res);
    expect(result.statusCode).toBe(400);
    expect(result.body.message).toBe('Invalid payment signature');
    expect(publishMessage).not.toHaveBeenCalled();
  });
});

describe('verifyPayment — property: any combination of missing fields always returns 400', () => {
  test('fast-check: requests with at least one missing required field always return 400', async () => {
    const validStr = fc.string({ minLength: 1, maxLength: 30 }).filter(s => s.trim().length > 0);
    const missingFieldsArb = fc.subarray(
      ['razorpay_order_id', 'razorpay_payment_id', 'razorpay_signature'],
      { minLength: 1 }
    );

    await fc.assert(
      fc.asyncProperty(
        validStr, validStr, validStr, missingFieldsArb,
        async (orderId, paymentId, signature, missingFields) => {
          const body = { razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: signature };
          for (const field of missingFields) delete body[field];

          const { res, result } = makeRes();
          await verifyPayment({ body }, res);

          expect(result.statusCode).toBe(400);
          expect(result.body).toHaveProperty('message');
        }
      ),
      { numRuns: 200 }
    );
  });
});

// ── createOrder preservation ──────────────────────────────────────────────────

describe('createOrder — preservation: valid Pending order with cache miss → 200', () => {
  test('well-formed request creates Razorpay order and caches it', async () => {
    mockFindOne.mockResolvedValue({ status: 'Pending', totalAmount: 250 });
    getCache.mockResolvedValue(null);
    const newOrder = { id: 'order_new', amount: 25000, currency: 'INR' };
    mockOrdersCreate.mockResolvedValue(newOrder);

    const { res, result } = makeRes();
    await createOrder({ body: { orderId: '64abc' }, user: { _id: 'u1' } }, res);

    expect(result.statusCode).toBe(200);
    expect(result.body).toEqual(newOrder);
    expect(setCache).toHaveBeenCalledWith('payment:dedup:u1:64abc', newOrder, 600);
  });
});

describe('createOrder — preservation: property: missing orderId always returns 400', () => {
  test('fast-check: any request without orderId returns 400', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.option(fc.constant(undefined), { nil: undefined }),
        async () => {
          const { res, result } = makeRes();
          await createOrder({ body: {}, user: { _id: 'u1' } }, res);
          expect(result.statusCode).toBe(400);
          expect(result.body.message).toMatch(/orderId/);
        }
      ),
      { numRuns: 50 }
    );
  });
});

// ── confirmPayment preservation ───────────────────────────────────────────────

describe('confirmPayment — preservation: captured payment → 200 + publish', () => {
  test('captured status updates order and publishes event', async () => {
    mockPaymentsFetch.mockResolvedValue({ status: 'captured' });
    mockFindByIdAndUpdate.mockResolvedValue({ _id: '64abc', paymentId: 'pay_1' });

    const { res, result } = makeRes();
    await confirmPayment({
      body: { razorpay_order_id: 'ord_1', razorpay_payment_id: 'pay_1', orderId: '64abc' },
      user: { _id: 'u1' },
    }, res);

    expect(result.statusCode).toBe(200);
    expect(result.body.message).toBe('Payment confirmed');
    expect(publishMessage).toHaveBeenCalledWith('payment.verified', expect.objectContaining({
      orderId: '64abc',
      razorpay_order_id: 'ord_1',
      razorpay_payment_id: 'pay_1',
    }));
  });
});

describe('confirmPayment — preservation: property: missing fields always return 400', () => {
  test('fast-check: any combination of missing required fields returns 400', async () => {
    const validStr = fc.string({ minLength: 1, maxLength: 20 }).filter(s => s.trim().length > 0);
    const missingFieldsArb = fc.subarray(
      ['razorpay_order_id', 'razorpay_payment_id', 'orderId'],
      { minLength: 1 }
    );

    await fc.assert(
      fc.asyncProperty(
        validStr, validStr, validStr, missingFieldsArb,
        async (a, b, c, missingFields) => {
          const body = { razorpay_order_id: a, razorpay_payment_id: b, orderId: c };
          for (const field of missingFields) delete body[field];

          const { res, result } = makeRes();
          await confirmPayment({ body, user: { _id: 'u1' } }, res);

          expect(result.statusCode).toBe(400);
          expect(result.body).toHaveProperty('message');
        }
      ),
      { numRuns: 100 }
    );
  });
});
