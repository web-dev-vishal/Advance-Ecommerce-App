# Implementation Plan

- [x] 1. Write bug condition exploration test
  - **Property 1: Bug Condition** - TypeError on req.query Assignment
  - **CRITICAL**: This test MUST FAIL on unfixed code — failure confirms the bug exists
  - **DO NOT attempt to fix the test or the code when it fails**
  - **NOTE**: This test encodes the expected behavior — it will validate the fix when it passes after implementation
  - **GOAL**: Surface counterexamples that demonstrate that every incoming HTTP request crashes with a TypeError before reaching any route handler
  - **Scoped PBT Approach**: isBugCondition(X) is true for ALL requests, so scope the property to concrete failing cases: GET /, GET /?foo=bar, POST /api/auth/login, GET /?$where=1
  - Create `backend/tests/queryPatch.exploration.test.js`
  - Mount the Express app from `backend/index.js` using `supertest`
  - Test 1 — GET with no query string: `GET /` should return 200; on unfixed code it returns 500 with TypeError
  - Test 2 — GET with benign query string: `GET /?foo=bar` should return 200; on unfixed code it returns 500
  - Test 3 — POST with JSON body: `POST /api/auth/login` with `{ "email": "a@b.com", "password": "x" }` should return 400/401; on unfixed code it returns 500
  - Test 4 — GET with malicious query string: `GET /?$where=1` should be sanitized and return 200/404; on unfixed code it returns 500
  - **Property 1: Bug Condition** — for all requests (isBugCondition always true), assert `response.status !== 500` and no TypeError in response body
  - Run test on UNFIXED code (before adding `patchQueryWritable`)
  - **EXPECTED OUTCOME**: Tests FAIL — all requests return 500 with `"Cannot set property query of #<IncomingMessage> which has only a getter"`
  - Document counterexamples found (e.g., `GET /` → 500 TypeError, `GET /?foo=bar` → 500 TypeError)
  - Mark task complete when tests are written, run, and failures are documented
  - _Requirements: 1.1, 1.2, 1.3_

- [x] 2. Write preservation property tests (BEFORE implementing fix)
  - **Property 2: Preservation** - Sanitization and Route Behaviour Unchanged
  - **IMPORTANT**: Follow observation-first methodology — observe intended behaviour on the fixed code first, since unfixed code crashes on every request
  - Create `backend/tests/queryPatch.preservation.test.js`
  - Mount the Express app from `backend/index.js` using `supertest`
  - **Observation 1**: `GET /` returns 200 with `{ name: "ShopNest API", status: "online" }` (home route)
  - **Observation 2**: `GET /?foo=bar` returns 200 — benign query string passes through unchanged
  - **Observation 3**: `GET /?$where=1` returns 200 — `$where` key is stripped by `express-mongo-sanitize` before reaching the route
  - **Observation 4**: `POST /api/auth/login` with missing fields returns 400 — body sanitization still works
  - Write property-based test using `fast-check`: generate arbitrary query objects with random `$`-prefixed keys; assert they are stripped from `req.query` before reaching the route handler (sanitization preserved)
  - Write property-based test: generate arbitrary benign query strings (no `$`-prefixed keys); assert they arrive at the route handler unchanged (clean passthrough preserved)
  - Write concrete test: `GET /` always returns 200 with expected shape (route response preserved)
  - Verify tests PASS on UNFIXED code for the non-crashing baseline (note: since unfixed code crashes, these tests are written to pass on the fixed code and serve as regression guards)
  - _Requirements: 3.1, 3.2, 3.3, 3.4_

- [x] 3. Fix for incoming-message-query-setter-error (TypeError on req.query in Express 5 + express-mongo-sanitize)

  - [x] 3.1 Implement the patchQueryWritable middleware in backend/index.js
    - Open `backend/index.js`
    - Define the middleware function immediately before `app.use(mongoSanitize())`:
      ```js
      function patchQueryWritable(req, _res, next) {
        Object.defineProperty(req, 'query', {
          value: req.query,
          writable: true,
          enumerable: true,
          configurable: true,
        });
        next();
      }
      ```
    - Register it with `app.use(patchQueryWritable)` directly above `app.use(mongoSanitize())`
    - Do NOT change any other middleware, routes, or configuration
    - Resulting order: `express.json` → `express.urlencoded` → `patchQueryWritable` → `mongoSanitize()` → `hpp()`
    - _Bug_Condition: isBugCondition(X) = true for ALL incoming HTTP requests (express-mongo-sanitize always attempts req['query'] = target)_
    - _Expected_Behavior: result.statusCode ≠ 500 AND no TypeError thrown during middleware execution_
    - _Preservation: MongoDB operator keys in req.body/params/headers/query still stripped; all route responses (200/201/400/401/403/404) unchanged; helmet/cors/hpp/authMiddleware unaffected_
    - _Requirements: 2.1, 2.2, 2.3, 3.1, 3.2, 3.3, 3.4_

  - [x] 3.2 Verify bug condition exploration test now passes
    - **Property 1: Expected Behavior** - No TypeError on req.query Assignment
    - **IMPORTANT**: Re-run the SAME tests from task 1 — do NOT write new tests
    - The tests from task 1 encode the expected behavior (status ≠ 500, no TypeError)
    - Run `backend/tests/queryPatch.exploration.test.js` on the FIXED code
    - **EXPECTED OUTCOME**: Tests PASS — all requests return their expected status codes (200, 400, 401) instead of 500
    - _Requirements: 2.1, 2.2, 2.3_

  - [x] 3.3 Verify preservation tests still pass
    - **Property 2: Preservation** - Sanitization and Route Behaviour Unchanged
    - **IMPORTANT**: Re-run the SAME tests from task 2 — do NOT write new tests
    - Run `backend/tests/queryPatch.preservation.test.js` on the FIXED code
    - **EXPECTED OUTCOME**: Tests PASS — sanitization still strips MongoDB operators, benign queries pass through, route responses are unchanged
    - Confirm no regressions in existing test suite: run `backend/tests/paymentController.exploration.test.js` and `backend/tests/paymentController.preservation.test.js` as well
    - _Requirements: 3.1, 3.2, 3.3, 3.4_

- [x] 4. Checkpoint — Ensure all tests pass
  - Run the full backend test suite: `npm test` (or `npx jest --runInBand`) from the `backend/` directory
  - Confirm `queryPatch.exploration.test.js` passes
  - Confirm `queryPatch.preservation.test.js` passes
  - Confirm `paymentController.exploration.test.js` passes
  - Confirm `paymentController.preservation.test.js` passes
  - Confirm `paymentController.test.js` passes
  - Ensure all tests pass; ask the user if questions arise
