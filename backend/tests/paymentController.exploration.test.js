/**
 * Bug Condition Exploration Test — Property 1
 *
 * Validates: Requirements 1.3, 2.4
 *
 * GOAL: Demonstrate that malformed/empty/odd-length razorpay_signature values
 * return HTTP 400 and never throw a RangeError (which would produce a 500).
 *
 * UNFIXED CODE BEHAVIOUR (documented counterexample):
 *   On the original code that used `Buffer.from(razorpay_signature, 'hex')`:
 *     - razorpay_signature = ""   → Buffer.from("", 'hex')   = 0-byte buffer
 *     - razorpay_signature = "zz" → Buffer.from("zz", 'hex') = 0-byte buffer
 *     - razorpay_signature = "abc"→ Buffer.from("abc", 'hex')= 1-byte buffer (odd-length truncated)
 *   In all cases the resulting buffer length differed from the 32-byte expectedSign buffer,
 *   causing `crypto.timingSafeEqual` to throw:
 *     RangeError [ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH]:
 *       Input buffers must have the same byte length
 *   This propagated as an unhandled error → 500 response instead of 400.
 *
 * FIXED CODE BEHAVIOUR (current code uses `Buffer.from(..., 'utf8')`):
 *   Both buffers are always the same length as the UTF-8 string length.
 *   The explicit `sigBuffer.length === expBuffer.length` guard short-circuits
 *   before `timingSafeEqual` is called, so no RangeError is ever thrown.
 *   All malformed inputs correctly return 400.
 */

'use strict';

const crypto = require('crypto');
const fc = require('fast-check');

// ── Mocks ────────────────────────────────────────────────────────────────────

// Mock publishMessage so verifyPayment doesn't need a live RabbitMQ connection
jest.mock('../config/rabbitmq', () => ({
  publishMessage: jest.fn().mockResolvedValue(undefined),
}));

// Set a deterministic test secret before loading the controller
const TEST_SECRET = 'test_secret_key';
process.env.RAZORPAY_KEY_SECRET = TEST_SECRET;

// Load the controller AFTER env is set
const { verifyPayment } = require('../controllers/paymentController');

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a minimal mock Express req/res pair.
 * Returns { req, res, statusCode, body } where statusCode and body are
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

// ── Concrete malformed-signature tests ───────────────────────────────────────

describe('verifyPayment — malformed signature returns 400, never 500', () => {
  const malformedCases = [
    { label: 'empty string', sig: '' },
    { label: 'non-hex "zz"', sig: 'zz' },
    { label: 'odd-length "abc"', sig: 'abc' },
    { label: 'non-hex chars "!@#$"', sig: '!@#$' },
    { label: 'single char "a"', sig: 'a' },
  ];

  for (const { label, sig } of malformedCases) {
    test(`razorpay_signature = "${sig}" (${label}) → 400, no exception`, async () => {
      const { req, res, result } = buildReqRes({ razorpay_signature: sig });

      // Must not throw
      await expect(verifyPayment(req, res)).resolves.not.toThrow();

      // Must return 400 (invalid signature), never 500
      expect(result.statusCode).toBe(400);
    });
  }
});

// ── Property-based test ───────────────────────────────────────────────────────

/**
 * Property 1: Bug Condition — Verification Never Returns 500
 *
 * For any razorpay_signature that is NOT a valid 64-character hex string,
 * verifyPayment SHALL return 400 and SHALL NOT throw.
 *
 * Validates: Requirements 1.3, 2.4
 */
describe('verifyPayment — property: non-64-char/non-hex signature always returns 400', () => {
  test('fast-check: arbitrary non-64-char or non-hex strings never cause 500', async () => {
    // Generate strings that are either wrong length or contain non-hex characters
    const nonValidHex64 = fc.oneof(
      // Strings shorter than 64 chars
      fc.string({ minLength: 0, maxLength: 63 }),
      // Strings longer than 64 chars
      fc.string({ minLength: 65, maxLength: 128 }),
      // Exactly 64 chars but containing at least one non-hex character
      fc.stringMatching(/^[^0-9a-fA-F].{63}$|^.{63}[^0-9a-fA-F]$/),
    );

    await fc.assert(
      fc.asyncProperty(nonValidHex64, async (sig) => {
        const { req, res, result } = buildReqRes({ razorpay_signature: sig });

        // Must not throw
        let threw = false;
        try {
          await verifyPayment(req, res);
        } catch {
          threw = true;
        }

        expect(threw).toBe(false);
        // Status must be 400 (invalid signature) — never 500
        expect(result.statusCode).toBe(400);
      }),
      { numRuns: 200 }
    );
  });
});
