# Implementation Plan

- [x] 1. Write bug condition exploration test
  - **Property 1: Bug Condition** - Malformed/Empty Signature Returns 400 Never 500
  - **CRITICAL**: This test MUST FAIL on unfixed code — failure confirms the bug exists
  - **DO NOT attempt to fix the test or the code when it fails**
  - **NOTE**: This test encodes the expected behavior — it will validate the fix when it passes after implementation
  - **GOAL**: Surface counterexamples that demonstrate `timingSafeEqual` throws on malformed hex inputs
  - **Scoped PBT Approach**: Scope the property to the concrete failing cases — `razorpay_signature` values that are empty, odd-length, or contain non-hex characters (e.g. `""`, `"zz"`, `"abc"`)
  - Unit-test `verifyPayment` directly (mock `publishMessage` and `RAZORPAY_KEY_SECRET`)
  - For each malformed signature input, assert `res.status` is 400 and no exception is thrown
  - Use fast-check or similar to generate random non-64-char and non-hex strings as `razorpay_signature`
  - Run test on UNFIXED code (revert `Buffer.from(..., 'utf8')` to `Buffer.from(..., 'hex')` temporarily to observe failure)
  - **EXPECTED OUTCOME**: Test FAILS with `RangeError` / 500 on unfixed code (proves bug 3 existed)
  - Document counterexamples found (e.g. `razorpay_signature = "zz"` → `timingSafeEqual` throws → 500)
  - Mark task complete when test is written, run, and failure is documented
  - _Requirements: 1.3, 2.4_

- [x] 2. Write preservation property tests (BEFORE implementing fix)
  - **Property 2: Preservation** - Well-Formed Request Behaviour Unchanged
  - **IMPORTANT**: Follow observation-first methodology
  - Observe on current (fixed) code: missing-field requests return 400 with validation message
  - Observe on current (fixed) code: valid HMAC (computed with real or test secret) returns 200
  - Observe on current (fixed) code: well-formed but mismatched 64-char hex signature returns 400
  - Write property-based tests: for all requests where `isBugCondition(X)` is false, assert response matches observed behaviour
  - Test cases to cover:
    - Missing `razorpay_order_id` / `razorpay_payment_id` / `razorpay_signature` → 400
    - Valid HMAC-SHA256 signature with matching secret → 200 and `publishMessage` called
    - Valid 64-char hex that does not match HMAC → 400
  - Verify tests PASS on current (already-fixed) code
  - _Requirements: 3.1, 3.2, 3.3, 3.4_

- [x] 3. Add startup env var validation and write unit tests

  - [x] 3.1 Add startup env var validation in `backend/server.js`
    - Before calling `start()`, check that `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` are non-empty strings
    - If either is missing or empty, log a clear error (`[Startup] Missing required env var: <KEY>`) and call `process.exit(1)`
    - Place the guard at the top of `server.js`, after `dotenv.config()` loads
    - _Bug_Condition: `RAZORPAY_KEY_SECRET = ""` (isBugCondition emptySecret branch)_
    - _Expected_Behavior: process exits with code 1 and a descriptive message before any connection is attempted_
    - _Preservation: does not affect runtime behaviour when both vars are set_
    - _Requirements: 1.1, 1.4, 2.1, 2.5_

  - [x] 3.2 Write unit tests for `verifyPayment` edge cases
    - Test file: `backend/tests/paymentController.test.js` (or equivalent)
    - Mock `publishMessage`, `crypto.timingSafeEqual`, and `process.env.RAZORPAY_KEY_SECRET`
    - Cover:
      - `razorpay_signature = ""` → 400, no throw
      - `razorpay_signature = "zz"` (non-hex) → 400, no throw
      - `razorpay_signature = "abc"` (odd-length) → 400, no throw
      - Missing `razorpay_order_id` → 400 with validation message
      - Missing `razorpay_payment_id` → 400 with validation message
      - Missing `razorpay_signature` → 400 with validation message
      - Correct HMAC-SHA256 signature → 200, `publishMessage` called with correct payload
      - Valid 64-char hex that does not match → 400, `publishMessage` not called
    - _Requirements: 2.2, 2.3, 2.4, 3.1, 3.4_

  - [x] 3.3 Write unit tests for `createOrder` edge cases
    - Cover:
      - `amount = 0` → 400 `Valid amount is required`
      - `amount = -5` → 400 `Valid amount is required`
      - Valid amount, cache hit → returns cached order, Razorpay SDK not called
      - Valid amount, cache miss → calls Razorpay SDK, caches result, returns order
    - _Requirements: 3.2, 3.3_

  - [x] 3.4 Verify bug condition exploration test now passes
    - **Property 1: Expected Behavior** - Malformed/Empty Signature Returns 400 Never 500
    - **IMPORTANT**: Re-run the SAME test from task 1 — do NOT write a new test
    - The test from task 1 encodes the expected behavior
    - When this test passes, it confirms the length-guard fix is working correctly
    - **EXPECTED OUTCOME**: Test PASSES (confirms bug 3 is fixed)
    - _Requirements: 2.4_

  - [x] 3.5 Verify preservation tests still pass
    - **Property 2: Preservation** - Well-Formed Request Behaviour Unchanged
    - **IMPORTANT**: Re-run the SAME tests from task 2 — do NOT write new tests
    - **EXPECTED OUTCOME**: Tests PASS (confirms no regressions)
    - Confirm all tests still pass after startup guard addition

- [x] 4. Checkpoint — Ensure all tests pass
  - Run the full test suite and confirm all tests pass
  - Verify startup guard exits cleanly when env vars are missing (manual smoke test or integration test)
  - Ask the user if any questions arise
