'use strict';

/**
 * Unit Tests — createOrder, confirmPayment, verifyPayment
 *
 * Validates: Requirements 1.1, 1.2, 1.3, 2.1–2.8, 3.1–3.7, 4.1–4.6
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

// Set env vars before loading the controller
process.env.RAZORPAY_KEY_ID = 'test_key_id';
process.env.RAZORPAY_KEY_SECRET = 'test_secret_key';

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

function computeValidSig(orderId, paymentId) {
  return crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update(`${orderId}|${paymentId}`)
    .digest('hex');
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ── createOrder ───────────────────────────────────────────────────────────────

describe('createOrder — input validation', () => {
  test('missing orderId → 400', async () => {
    const { res, result } = makeRes();
    await createOrder({ body: {}, user: { _id: 'u1' } }, res);
    expect(result.statusCode).toBe(400);
    expect(result.body.message).toMatch(/orderId/);
  });

  test('orderId is number → 400', async () => {
    const { res, result } = makeRes();
    await createOrder({ body: { orderId: 123 }, user: { _id: 'u1' } }, res);
    expect(result.statusCode).toBe(400);
  });
});

describe('createOrder — order lookup', () => {
  test('order not found → 404', async () => {
    mockFindOne.mockResolvedValue(null);
    const { res, result } = makeRes();
    await createOrder({ body: { orderId: '64abc' }, user: { _id: 'u1' } }, res);
    expect(result.statusCode).toBe(404);
    expect(result.body.message).toBe('Order not found');
  });

  test('order status not Pending → 400', async () => {
    mockFindOne.mockResolvedValue({ status: 'Shipped', totalAmount: 100 });
    const { res, result } = makeRes();
    await createOrder({ body: { orderId: '64abc' }, user: { _id: 'u1' } }, res);
    expect(result.statusCode).toBe(400);
    expect(result.body.message).toBe('Order is not in a payable state');
    expect(mockOrdersCreate).not.toHaveBeenCalled();
  });
});

describe('createOrder — dedup cache', () => {
  test('cache hit → returns cached order, Razorpay not called', async () => {
    mockFindOne.mockResolvedValue({ status: 'Pending', totalAmount: 500 });
    const cached = { id: 'order_cached', amount: 50000 };
    getCache.mockResolvedValue(cached);

    const { res, result } = makeRes();
    await createOrder({ body: { orderId: '64abc' }, user: { _id: 'u1' } }, res);

    expect(result.statusCode).toBe(200);
    expect(result.body).toEqual(cached);
    expect(mockOrdersCreate).not.toHaveBeenCalled();
  });

  test('cache miss → calls Razorpay with correct amount, caches result', async () => {
    mockFindOne.mockResolvedValue({ status: 'Pending', totalAmount: 500 });
    getCache.mockResolvedValue(null);
    const newOrder = { id: 'order_new', amount: 50000, currency: 'INR' };
    mockOrdersCreate.mockResolvedValue(newOrder);

    const { res, result } = makeRes();
    await createOrder({ body: { orderId: '64abc' }, user: { _id: 'u1' } }, res);

    expect(mockOrdersCreate).toHaveBeenCalledWith({
      amount: 50000,
      currency: 'INR',
      receipt: '64abc',
    });
    expect(setCache).toHaveBeenCalledWith('payment:dedup:u1:64abc', newOrder, 600);
    expect(result.statusCode).toBe(200);
    expect(result.body).toEqual(newOrder);
  });
});

describe('createOrder — Razorpay error', () => {
  test('Razorpay throws → 502', async () => {
    mockFindOne.mockResolvedValue({ status: 'Pending', totalAmount: 100 });
    getCache.mockResolvedValue(null);
    mockOrdersCreate.mockRejectedValue(new Error('Razorpay down'));

    const { res, result } = makeRes();
    await createOrder({ body: { orderId: '64abc' }, user: { _id: 'u1' } }, res);

    expect(result.statusCode).toBe(502);
    expect(result.body.message).toBe('Payment provider error');
  });
});

// ── confirmPayment ────────────────────────────────────────────────────────────

describe('confirmPayment — input validation', () => {
  const base = { razorpay_order_id: 'ord_1', razorpay_payment_id: 'pay_1', orderId: '64abc' };

  test.each(['razorpay_order_id', 'razorpay_payment_id', 'orderId'])(
    'missing %s → 400',
    async (field) => {
      const body = { ...base, [field]: undefined };
      const { res, result } = makeRes();
      await confirmPayment({ body, user: { _id: 'u1' } }, res);
      expect(result.statusCode).toBe(400);
      expect(result.body.message).toContain(field);
    }
  );
});

describe('confirmPayment — Razorpay fetch', () => {
  test('fetch throws → 502', async () => {
    mockPaymentsFetch.mockRejectedValue(new Error('network'));
    const { res, result } = makeRes();
    await confirmPayment({
      body: { razorpay_order_id: 'ord_1', razorpay_payment_id: 'pay_1', orderId: '64abc' },
      user: { _id: 'u1' },
    }, res);
    expect(result.statusCode).toBe(502);
  });

  test('status not captured/authorized → 402', async () => {
    mockPaymentsFetch.mockResolvedValue({ status: 'failed' });
    const { res, result } = makeRes();
    await confirmPayment({
      body: { razorpay_order_id: 'ord_1', razorpay_payment_id: 'pay_1', orderId: '64abc' },
      user: { _id: 'u1' },
    }, res);
    expect(result.statusCode).toBe(402);
    expect(result.body.status).toBe('failed');
  });
});

describe('confirmPayment — order update', () => {
  test('order not found → 404', async () => {
    mockPaymentsFetch.mockResolvedValue({ status: 'captured' });
    mockFindByIdAndUpdate.mockResolvedValue(null);
    const { res, result } = makeRes();
    await confirmPayment({
      body: { razorpay_order_id: 'ord_1', razorpay_payment_id: 'pay_1', orderId: '64abc' },
      user: { _id: 'u1' },
    }, res);
    expect(result.statusCode).toBe(404);
  });

  test('success → 200, publishMessage called with orderId', async () => {
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
      razorpay_order_id: 'ord_1',
      razorpay_payment_id: 'pay_1',
      orderId: '64abc',
      timestamp: expect.any(String),
    }));
  });

  test('authorized status also succeeds → 200', async () => {
    mockPaymentsFetch.mockResolvedValue({ status: 'authorized' });
    mockFindByIdAndUpdate.mockResolvedValue({ _id: '64abc' });
    const { res, result } = makeRes();
    await confirmPayment({
      body: { razorpay_order_id: 'ord_1', razorpay_payment_id: 'pay_1', orderId: '64abc' },
      user: { _id: 'u1' },
    }, res);
    expect(result.statusCode).toBe(200);
  });
});

// ── verifyPayment ─────────────────────────────────────────────────────────────

describe('verifyPayment — missing fields', () => {
  const base = { razorpay_order_id: 'ord_1', razorpay_payment_id: 'pay_1', razorpay_signature: 'a'.repeat(64) };

  test.each(['razorpay_order_id', 'razorpay_payment_id', 'razorpay_signature'])(
    'missing %s → 400',
    async (field) => {
      const body = { ...base, [field]: undefined };
      const { res, result } = makeRes();
      await verifyPayment({ body }, res);
      expect(result.statusCode).toBe(400);
      expect(result.body.message).toMatch(new RegExp(field));
    }
  );
});

describe('verifyPayment — malformed signature', () => {
  test.each([
    ['empty string', ''],
    ['non-hex "zz"', 'zz'],
    ['odd-length "abc"', 'abc'],
    ['63 chars', 'a'.repeat(63)],
    ['65 chars', 'a'.repeat(65)],
    ['unicode', '🔑'.repeat(16)],
  ])('%s → 400, no throw', async (_, sig) => {
    const { res, result } = makeRes();
    await expect(
      verifyPayment({ body: { razorpay_order_id: 'ord_1', razorpay_payment_id: 'pay_1', razorpay_signature: sig } }, res)
    ).resolves.not.toThrow();
    expect(result.statusCode).toBe(400);
  });
});

describe('verifyPayment — signature matching', () => {
  test('valid HMAC → 200, publishMessage called', async () => {
    const sig = computeValidSig('ord_1', 'pay_1');
    const { res, result } = makeRes();
    await verifyPayment({ body: { razorpay_order_id: 'ord_1', razorpay_payment_id: 'pay_1', razorpay_signature: sig } }, res);
    expect(result.statusCode).toBe(200);
    expect(result.body.message).toBe('Payment verified successfully');
    expect(publishMessage).toHaveBeenCalledWith('payment.verified', expect.objectContaining({
      razorpay_order_id: 'ord_1',
      razorpay_payment_id: 'pay_1',
      timestamp: expect.any(String),
    }));
  });

  test('valid 64-char hex but wrong HMAC → 400', async () => {
    const { res, result } = makeRes();
    await verifyPayment({ body: { razorpay_order_id: 'ord_1', razorpay_payment_id: 'pay_1', razorpay_signature: 'b'.repeat(64) } }, res);
    expect(result.statusCode).toBe(400);
    expect(result.body.message).toBe('Invalid payment signature');
    expect(publishMessage).not.toHaveBeenCalled();
  });
});
