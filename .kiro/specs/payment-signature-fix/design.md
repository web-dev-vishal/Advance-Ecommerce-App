# Payment Signature Fix — Bugfix Design

## Overview

Three compounding bugs caused all Razorpay payment verifications to fail in ShopNest's backend.

1. **Empty credentials** — `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` were blank in `.env`, so the HMAC was computed with an empty secret and the SDK could not authenticate with Razorpay.
2. **Body-parsing conflict** — `express.raw()` was registered before `express.json()` for the `/api/payment/verify` route, meaning the controller received a raw `Buffer` instead of a parsed object. The manual parse path was fragile and could silently fail.
3. **Unsafe `timingSafeEqual`** — the original code decoded the hex signature strings with `Buffer.from(..., 'hex')` before comparing. If either string was malformed (odd length, non-hex chars), the resulting buffers had different byte lengths and `timingSafeEqual` threw a `RangeError`, producing a 500 instead of a 400.

Bugs 2 and 3 are already fixed in code. Bug 1 requires the operator to supply real credentials. This document formalises the bug condition, the fix approach, and the validation strategy.

---

## Glossary

- **Bug_Condition (C)**: The set of inputs that trigger at least one of the three bugs — empty secret, Buffer body parse failure, or mismatched-length hex buffers.
- **Property (P)**: The desired outcome for any request that previously triggered the bug — the response status is 200 or 400, never 500, and no exception is thrown.
- **Preservation**: All existing behaviours for well-formed requests with valid credentials that must remain unchanged after the fix.
- **verifyPayment (F)**: The original `verifyPayment` function in `backend/controllers/paymentController.js` before the fixes.
- **verifyPayment' (F')**: The fixed `verifyPayment` function — reads `req.body` directly (parsed by `express.json()`), compares hex strings as UTF-8 buffers, guards against length mismatch.
- **createOrder**: The `createOrder` function in the same controller — unaffected by bugs 2 and 3, but depends on `RAZORPAY_KEY_ID` being set (bug 1).
- **timingSafeEqual**: `crypto.timingSafeEqual(a, b)` — throws `RangeError` if `a.byteLength !== b.byteLength`.
- **HMAC-SHA256**: The keyed hash used by Razorpay to sign `order_id|payment_id`.

---

## Bug Details

### Bug Condition

The bug manifests when any of the following conditions hold for an incoming `POST /api/payment/verify` request:

- `RAZORPAY_KEY_SECRET` is an empty string (empty-secret HMAC never matches Razorpay's signature)
- The request body arrives as a raw `Buffer` and JSON parsing fails (body-parsing conflict)
- `razorpay_signature` or the computed `expectedSign` hex string is malformed, causing `Buffer.from(..., 'hex')` to produce buffers of different lengths, making `timingSafeEqual` throw

**Formal Specification:**

```
FUNCTION isBugCondition(X)
  INPUT: X of type PaymentVerifyRequest
  OUTPUT: boolean

  emptySecret      ← (RAZORPAY_KEY_SECRET = "")
  bufferParseFail  ← (X.body IS Buffer AND JSON.parse(X.body) THROWS)
  lengthMismatch   ← (Buffer.from(X.razorpay_signature, 'hex').length
                      ≠ Buffer.from(expectedSign, 'hex').length)

  RETURN emptySecret OR bufferParseFail OR lengthMismatch
END FUNCTION
```

### Examples

- `RAZORPAY_KEY_SECRET = ""`, valid signature from Razorpay → HMAC computed with empty key → `expectedSign` never matches → returns 400 (wrong, but no crash). With real credentials this should return 200.
- `express.raw()` active, body is `Buffer` → `JSON.parse` on malformed buffer → controller throws → 500 response instead of 400.
- `razorpay_signature = "zz"` (non-hex, length 2) → `Buffer.from("zz", 'hex')` produces a 0-byte buffer → `timingSafeEqual` throws `RangeError` → 500 response instead of 400.
- `razorpay_signature` is a valid 64-char hex string, `RAZORPAY_KEY_SECRET` is set → both UTF-8 buffers are 64 bytes → `timingSafeEqual` runs safely → correct 200 or 400.

---

## Expected Behavior

### Preservation Requirements

**Unchanged Behaviors:**

- Missing-field validation: requests without `razorpay_order_id`, `razorpay_payment_id`, or `razorpay_signature` must still return `400` with a descriptive message (requirement 3.1).
- Order deduplication: `POST /api/payment/order` must still return a cached Razorpay order for the same user and amount within 10 minutes (requirement 3.2).
- Invalid-amount rejection: zero or negative amounts must still return `400 Valid amount is required` (requirement 3.3).
- RabbitMQ publish: a successful verification must still publish a `payment.verified` event with `razorpay_order_id`, `razorpay_payment_id`, and `timestamp` (requirement 3.4).
- Auth guard: requests without a valid JWT must still return `401 Unauthorized` (requirement 3.5).

**Scope:**

All inputs that do NOT satisfy `isBugCondition` — i.e. well-formed requests with valid credentials and a properly-parsed JSON body — must be completely unaffected by the fix.

---

## Hypothesized Root Cause

1. **Empty credentials in `.env`** — The `.env` file shipped with placeholder values (`RAZORPAY_KEY_ID=` / `RAZORPAY_KEY_SECRET=`). The application starts without validating that these are non-empty, so the SDK and HMAC silently use empty strings.

2. **`express.raw()` registered before `express.json()`** — A route-level `express.raw({ type: 'application/json' })` middleware was applied to `/api/payment/verify` to preserve the raw body for signature verification (a common Stripe-style pattern). However, Razorpay's verification does not require the raw body — it only needs the three IDs from the parsed JSON. The raw middleware intercepted the request before `express.json()` could parse it, leaving `req.body` as a `Buffer`.

3. **Hex-decode before `timingSafeEqual`** — The original code called `Buffer.from(sig, 'hex')` to decode the hex strings into binary before comparing. This is unnecessary for Razorpay (which returns a hex string, not binary), and it introduces a length-mismatch risk: any non-hex or odd-length input produces a shorter buffer, causing `timingSafeEqual` to throw rather than return `false`.

---

## Correctness Properties

Property 1: Bug Condition — Verification Never Returns 500

_For any_ request where `isBugCondition(X)` is true (empty secret, buffer parse failure, or malformed hex), the fixed `verifyPayment'` function SHALL return a response with HTTP status 200 or 400 and SHALL NOT throw an unhandled exception or return status 500.

**Validates: Requirements 2.2, 2.3, 2.4**

Property 2: Preservation — Well-Formed Request Behaviour Unchanged

_For any_ request where `isBugCondition(X)` is false (valid credentials, JSON-parsed body, well-formed hex strings), the fixed `verifyPayment'` function SHALL produce the same HTTP status and response body as the original `verifyPayment` function, preserving all existing validation, signature-matching, and RabbitMQ-publish behaviour.

**Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5**

---

## Fix Implementation

### Changes Required

**Bug 1 — Empty credentials (operator action required)**

- **File**: `backend/.env`
- **Change**: Set `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` to real Razorpay test/live credentials.
- **Optional hardening**: Add startup validation in `backend/server.js` (or `index.js`) that checks these vars are non-empty and exits with a clear error message if they are missing.

```
// Suggested startup guard (backend/server.js or index.js)
const REQUIRED_ENV = ['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET'];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`[Startup] Missing required env var: ${key}`);
    process.exit(1);
  }
}
```

**Bug 2 — Body-parsing conflict (ALREADY FIXED)**

- **File**: `backend/index.js`
- **Change applied**: Removed the route-level `express.raw()` middleware for `/api/payment/verify`. The global `express.json({ limit: '10kb' })` now handles all routes uniformly.
- **Controller change**: `verifyPayment` reads `req.body` directly as a plain object — no Buffer detection or manual `JSON.parse` needed.

**Bug 3 — Unsafe `timingSafeEqual` (ALREADY FIXED)**

- **File**: `backend/controllers/paymentController.js`
- **Change applied**: Compare the hex strings as UTF-8 buffers instead of decoding them from hex first.

```javascript
// Fixed comparison (current code)
const sigBuffer = Buffer.from(razorpay_signature, 'utf8');  // always 64 bytes for valid hex
const expBuffer = Buffer.from(expectedSign, 'utf8');         // always 64 bytes (SHA-256 hex)

const isValid =
  sigBuffer.length === expBuffer.length &&
  crypto.timingSafeEqual(sigBuffer, expBuffer);
```

The explicit length guard before `timingSafeEqual` ensures that a malformed `razorpay_signature` (wrong length or non-hex chars) causes `isValid` to be `false` rather than throwing a `RangeError`.

---

## Testing Strategy

### Validation Approach

Testing follows two phases: first, run exploratory tests against the unfixed code to surface counterexamples and confirm root causes; then run fix-checking and preservation tests against the fixed code.

---

### Exploratory Bug Condition Checking

**Goal**: Surface counterexamples that demonstrate each bug on unfixed code. Confirm or refute the root cause analysis.

**Test Plan**: Directly unit-test the `verifyPayment` logic with inputs that satisfy `isBugCondition`. Run on the unfixed code to observe failures.

**Test Cases**:

1. **Empty-secret HMAC mismatch** — Call `verifyPayment` with a valid Razorpay-style signature but `RAZORPAY_KEY_SECRET = ""`. Expect 400 (not 200), confirming the HMAC never matches. (Will fail on unfixed code if credentials were set.)
2. **Buffer body parse failure** — Pass `req.body` as a `Buffer` containing valid JSON. Expect the controller to parse it correctly. (Will fail on unfixed code where Buffer handling was fragile.)
3. **Malformed hex — `timingSafeEqual` throws** — Pass `razorpay_signature = "zz"` (non-hex). Expect 400. (Will throw `RangeError` on unfixed code, producing 500.)
4. **Odd-length hex** — Pass `razorpay_signature = "abc"` (3 chars, odd length). Expect 400. (Will throw on unfixed code.)

**Expected Counterexamples**:

- Unfixed code returns 500 for malformed hex inputs instead of 400.
- Possible causes: `Buffer.from(sig, 'hex')` produces wrong-length buffer → `timingSafeEqual` throws.

---

### Fix Checking

**Goal**: Verify that for all inputs where `isBugCondition(X)` holds, the fixed function returns 200 or 400 and never throws.

**Pseudocode:**

```
FOR ALL X WHERE isBugCondition(X) DO
  result ← verifyPayment'(X)
  ASSERT result.status IN {200, 400}
  ASSERT result does NOT throw
END FOR
```

**Test Cases**:

1. `razorpay_signature = "zz"` → expect 400, no exception.
2. `razorpay_signature = "abc"` (odd-length hex) → expect 400, no exception.
3. `razorpay_signature = ""` (empty string) → expect 400, no exception.
4. `razorpay_signature` is a valid 64-char hex but does not match → expect 400, no exception.
5. `razorpay_signature` matches the HMAC (with real secret set) → expect 200.

---

### Preservation Checking

**Goal**: Verify that for all inputs where `isBugCondition(X)` does NOT hold, the fixed function produces the same result as the original.

**Pseudocode:**

```
FOR ALL X WHERE NOT isBugCondition(X) DO
  ASSERT verifyPayment(X) = verifyPayment'(X)
END FOR
```

**Testing Approach**: Property-based testing is recommended because it generates many input combinations automatically and catches edge cases that manual tests miss.

**Test Cases**:

1. **Missing-field preservation** — Requests missing one or more of the three required fields must still return 400 with the validation message.
2. **Valid-signature preservation** — A correctly signed request (with real credentials) must still return 200 and publish to RabbitMQ.
3. **Invalid-but-well-formed signature preservation** — A 64-char hex string that does not match must still return 400.
4. **Auth guard preservation** — Requests without a JWT must still return 401 (tested at route level).

---

### Unit Tests

- Test `verifyPayment` with `razorpay_signature` values of varying lengths and character sets (valid hex, non-hex, empty, odd-length).
- Test that missing `razorpay_order_id`, `razorpay_payment_id`, or `razorpay_signature` each return 400.
- Test that a correctly computed HMAC-SHA256 signature returns 200 and calls `publishMessage`.
- Test `createOrder` with zero, negative, and valid amounts.

### Property-Based Tests

- Generate random strings as `razorpay_signature` and assert the response is always 200 or 400, never 500 (Property 1).
- Generate random valid hex strings of length ≠ 64 and assert the response is 400, never a thrown exception.
- Generate well-formed requests (valid credentials, correct HMAC) and assert the response matches the unfixed behaviour (Property 2).
- Generate requests missing random subsets of the three required fields and assert 400 is always returned.

### Integration Tests

- Full flow: create a Razorpay order → compute correct HMAC → call `/api/payment/verify` → expect 200 and RabbitMQ event.
- Tampered signature: create order → modify signature → call verify → expect 400.
- Unauthenticated request: call `/api/payment/verify` without JWT → expect 401.
- Startup validation: start server with empty `RAZORPAY_KEY_SECRET` → expect process to exit with a clear error (if startup guard is added).
