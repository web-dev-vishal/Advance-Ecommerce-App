/**
 * Preservation Property Tests — Property 2
 *
 * Validates: Requirements 3.1, 3.2, 3.3, 3.4
 *
 * GOAL: Verify that well-formed requests (where isBugCondition(X) is false)
 * behave correctly on the fixed code. These tests should PASS on the current
 * fixed code and confirm no regressions were introduced.
 *
 * PRESERVATION INVARIANTS:
 *   - Missing required fields → 400 with validation message
 *   - Valid HMAC-SHA256 signature (matching secret) → 200, publishMessage called
 *   - Valid 64-char hex that does NOT match HMAC → 400, publishMessage not called
 *   - For any combination of missing fields → always 400
 */

'use strict';

const crypto = require('crypto');
const fc = require('fast-check');

// ── Mocks ────────────────────────────────────────────────────────────────────

jest.mock('../config/rabbitmq', () => ({
  publishMessage: jest.fn().mockResolvedValue(undefined),
}));

const TEST_SECRET = 'test_secret_key';
process.env.RAZORPAY_KEY_SECRET = TEST_SECRET;

const { verifyPayment } = require('../controllers/paymentController');
const { publishMessage } = require('../config/rabbitmq');

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a minimal mock Express req/res pair.
 * Returns { req, res, result } where result.statusCode and result.body are
 * populated after the handler resolves.
 */
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

/**
 * Compute the correct HMAC-SHA256 signature for a given order/payment pair.
 */
function computeValidSignature(orderId, paymentId) {
  return crypto
    .createHmac('sha256', TEST_SECRET)
    .update(`${orderId}|${paymentId}`)
    .digest('hex');
}

// ── Reset mocks between tests ─────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
});

// ── Concrete preservation tests ───────────────────────────────────────────────

describe('verifyPayment — missing field validation returns 400', () => {
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

describe('verifyPayment — valid HMAC signature → 200 and publishMessage called', () => {
  test('correctly computed HMAC-SHA256 signature returns 200 and publishes event', async () => {
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
});

describe('verifyPayment — valid 64-char hex that does NOT match HMAC → 400', () => {
  test('well-formed but mismatched 64-char hex signature returns 400, publishMessage not called', async () => {
    // A valid 64-char hex string that is NOT the correct HMAC
    const wrongSig = 'a'.repeat(64);

    const { req, res, result } = buildReqRes({ razorpay_signature: wrongSig });

    await verifyPayment(req, res);

    expect(result.statusCode).toBe(400);
    expect(result.body.message).toBe('Invalid payment signature');
    expect(publishMessage).not.toHaveBeenCalled();
  });
});

// ── Property-based tests ──────────────────────────────────────────────────────

/**
 * Property 2: Preservation — Well-Formed Request Behaviour Unchanged
 *
 * For any combination of missing required fields, verifyPayment SHALL
 * always return 400 with a validation message.
 *
 * Validates: Requirements 3.1, 3.2, 3.3, 3.4
 */
describe('verifyPayment — property: any combination of missing fields always returns 400', () => {
  test('fast-check: requests with at least one missing required field always return 400', async () => {
    // Arbitraries for valid-looking field values
    const validOrderId = fc.string({ minLength: 1, maxLength: 30 }).filter(s => s.trim().length > 0);
    const validPaymentId = fc.string({ minLength: 1, maxLength: 30 }).filter(s => s.trim().length > 0);
    const validSignature = fc.string({ minLength: 1, maxLength: 64 }).filter(s => s.trim().length > 0);

    // Generate a body where at least one of the three fields is missing (undefined)
    // We pick a non-empty subset of fields to omit (1, 2, or all 3)
    const missingFieldsArb = fc.subarray(
      ['razorpay_order_id', 'razorpay_payment_id', 'razorpay_signature'],
      { minLength: 1 }
    );

    await fc.assert(
      fc.asyncProperty(
        validOrderId,
        validPaymentId,
        validSignature,
        missingFieldsArb,
        async (orderId, paymentId, signature, missingFields) => {
          const body = {
            razorpay_order_id: orderId,
            razorpay_payment_id: paymentId,
            razorpay_signature: signature,
          };

          // Remove the selected fields to simulate missing input
          for (const field of missingFields) {
            delete body[field];
          }

          const result = { statusCode: null, body: null };
          const req = { body };
          const res = {
            status(code) { result.statusCode = code; return res; },
            json(data) { result.body = data; return res; },
          };

          await verifyPayment(req, res);

          expect(result.statusCode).toBe(400);
          expect(result.body).toHaveProperty('message');
        }
      ),
      { numRuns: 200 }
    );
  });
});
