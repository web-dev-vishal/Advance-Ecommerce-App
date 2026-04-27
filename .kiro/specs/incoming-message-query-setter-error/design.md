# Incoming Message Query Setter Error — Bugfix Design

## Overview

Every HTTP request to the ShopNest API crashes with
`TypeError: Cannot set property query of #<IncomingMessage> which has only a getter`
before any route handler is reached.

The root cause is a compatibility break between Express 5 and
`express-mongo-sanitize` v2.x. Express 5 defines `req.query` as a **read-only
getter** on the `IncomingMessage` prototype. The sanitizer iterates over
`['body', 'params', 'headers', 'query']` and performs a direct assignment
`req[key] = target` for each key. When `key === 'query'`, the assignment throws
because there is no setter, crashing the entire request pipeline.

The fix is a small custom middleware that runs **before** `mongoSanitize()`. It
redefines `req.query` as a writable own property on the request object using
`Object.defineProperty`, so the sanitizer's subsequent assignment succeeds without
error. No other middleware or route behaviour changes.

---

## Glossary

- **Bug_Condition (C)**: The condition that triggers the bug — any incoming HTTP
  request processed by the Express 5 application, because `express-mongo-sanitize`
  unconditionally attempts `req['query'] = target` on every request.
- **Property (P)**: The desired behaviour when the bug condition holds — the request
  SHALL complete the full middleware pipeline without throwing a `TypeError`, and the
  route handler SHALL return its expected response.
- **Preservation**: All existing sanitization behaviour, route responses, and
  middleware side-effects that must remain unchanged after the fix.
- **`mongoSanitize()`**: The `express-mongo-sanitize` v2.x middleware in
  `backend/index.js` that sanitizes `req.body`, `req.params`, `req.headers`, and
  `req.query` by direct property assignment.
- **`req.query`**: In Express 5, a read-only getter defined on the
  `IncomingMessage` prototype; in Express 4 it was a plain writable property.
- **`Object.defineProperty`**: The JavaScript built-in used to redefine a property
  descriptor on a specific object instance, overriding any inherited getter with a
  writable own property.
- **`patchQueryWritable`**: The name of the custom middleware introduced by this fix.

---

## Bug Details

### Bug Condition

The bug fires unconditionally on **every** incoming request because
`express-mongo-sanitize` always iterates over
`['body', 'params', 'headers', 'query']` and always executes
`req['query'] = sanitized` regardless of whether the query string contains
prohibited keys.

**Formal Specification:**

```
FUNCTION isBugCondition(X)
  INPUT:  X — any incoming HTTP request handled by the Express 5 application
  OUTPUT: boolean

  // express-mongo-sanitize always attempts req['query'] = target,
  // so the bug fires on every request without exception.
  RETURN true
END FUNCTION
```

### Examples

- `GET /api/products` — no query string at all → crashes with TypeError (expected: 200 product list)
- `POST /api/auth/login` with JSON body → crashes with TypeError (expected: 200 token response)
- `GET /api/products?category=electronics` — benign query string → crashes with TypeError (expected: 200 filtered list)
- `GET /api/products?$where=1` — malicious query string → crashes with TypeError (expected: sanitized and processed normally)

---

## Expected Behavior

### Preservation Requirements

**Unchanged Behaviors:**

- MongoDB operator keys in `req.body`, `req.params`, `req.headers`, and `req.query`
  (e.g. `$where`, `$gt`) MUST continue to be stripped by `express-mongo-sanitize`
- Requests without prohibited keys MUST continue to pass `req.query`, `req.body`,
  `req.params`, and `req.headers` through to route handlers unchanged
- All existing route responses (200, 201, 400, 401, 403, 404) MUST remain identical
  to their pre-fix behaviour
- All other middleware (`helmet`, `cors`, `hpp`, `authMiddleware`, etc.) MUST
  continue to operate exactly as before

**Scope:**

The fix touches only the property descriptor of `req.query` on each individual
request object. It does not alter the `IncomingMessage` prototype, does not change
the sanitizer's logic, and does not affect any other request property. All inputs
and all routes are in scope for preservation.

---

## Hypothesized Root Cause

1. **Express 5 prototype change**: Express 5 moved the `query` property from a
   plain writable property (Express 4) to a read-only getter defined on the
   `IncomingMessage` prototype via `Object.defineProperty` with no `set` accessor.
   Any direct assignment to `req.query` therefore throws in strict mode and in
   modern V8.

2. **`express-mongo-sanitize` v2.x unconditional assignment**: The sanitizer uses
   `req[key] = sanitized(req[key])` for all four keys without checking whether the
   property is writable. This was safe in Express 4 but breaks in Express 5.

3. **No own-property shadow on the request instance**: Because `req.query` is
   inherited from the prototype (not an own property of the request instance),
   there is no writable slot to assign into. Creating an own property via
   `Object.defineProperty` on the instance shadows the prototype getter and
   provides the writable slot the sanitizer needs.

4. **No upstream fix available**: `express-mongo-sanitize` v2.x has not been
   patched for Express 5 compatibility. Upgrading to a hypothetical v3 is not
   currently an option, so the fix must be applied in application code.

---

## Correctness Properties

Property 1: Bug Condition — No TypeError on req.query Assignment

_For any_ incoming HTTP request (i.e. for all X where isBugCondition(X) is true),
the fixed middleware pipeline SHALL process the request without throwing a
`TypeError` on `req.query`, and the route handler SHALL return its expected HTTP
response (status ≠ 500 caused by this error).

**Validates: Requirements 2.1, 2.2, 2.3**

Property 2: Preservation — Sanitization and Route Behaviour Unchanged

_For any_ request processed by the fixed pipeline, `express-mongo-sanitize` SHALL
still sanitize MongoDB operator keys from `req.body`, `req.params`, `req.headers`,
and `req.query`, and all route handlers SHALL return the same application-level
responses as they did before the fix (i.e. F'(X).routeResponse = F(X).intendedRouteResponse).

**Validates: Requirements 3.1, 3.2, 3.3, 3.4**

---

## Fix Implementation

### Changes Required

**File**: `backend/index.js`

**Approach**: Insert a one-liner custom middleware immediately before `app.use(mongoSanitize())`.

**Specific Changes**:

1. **Add `patchQueryWritable` middleware** — define a new middleware function that
   calls `Object.defineProperty(req, 'query', { value: req.query, writable: true, enumerable: true, configurable: true })`
   and then calls `next()`. This shadows the read-only prototype getter with a
   writable own property on the specific request instance.

2. **Register before `mongoSanitize()`** — insert `app.use(patchQueryWritable)`
   directly above the existing `app.use(mongoSanitize())` line so the property is
   writable by the time the sanitizer runs.

3. **No other changes** — the sanitizer call, all other middleware, all routes, and
   all configuration remain exactly as they are.

**Resulting middleware order** (relevant excerpt):

```
app.use(express.json(...))
app.use(express.urlencoded(...))
app.use(patchQueryWritable)      // ← new: makes req.query writable
app.use(mongoSanitize())         // ← unchanged: now succeeds
app.use(hpp())
```

---

## Testing Strategy

### Validation Approach

The testing strategy follows a two-phase approach: first, surface counterexamples
that demonstrate the bug on the **unfixed** code, then verify the fix works
correctly and preserves existing behaviour.

### Exploratory Bug Condition Checking

**Goal**: Surface counterexamples that demonstrate the bug BEFORE implementing the
fix. Confirm the root cause analysis. If the tests do not fail as expected, we will
need to re-hypothesize.

**Test Plan**: Mount the Express app (or a minimal reproduction of the middleware
stack) and fire HTTP requests. Assert that the response status is not 500 and that
no TypeError is thrown. Run these tests on the **unfixed** code to observe failures.

**Test Cases**:

1. **GET with no query string** — `GET /` should return 200; on unfixed code it
   returns 500 with TypeError (will fail on unfixed code)
2. **GET with benign query string** — `GET /?foo=bar` should return 200; on unfixed
   code it returns 500 (will fail on unfixed code)
3. **POST with JSON body** — `POST /api/auth/login` with valid body should return
   400/401; on unfixed code it returns 500 (will fail on unfixed code)
4. **GET with malicious query string** — `GET /?$where=1` should be sanitized and
   return 200/404; on unfixed code it returns 500 (will fail on unfixed code)

**Expected Counterexamples**:

- All requests return HTTP 500 with body `{ "status": 500, "message": "Cannot set property query of #<IncomingMessage> which has only a getter" }`
- Possible causes confirmed: Express 5 read-only getter + sanitizer direct assignment

### Fix Checking

**Goal**: Verify that for all inputs where the bug condition holds (every request),
the fixed pipeline produces the expected behaviour.

**Pseudocode:**

```
FOR ALL X WHERE isBugCondition(X) DO   // i.e. for every request
  result := handleRequest_fixed(X)
  ASSERT result.statusCode ≠ 500
  ASSERT no TypeError thrown during middleware execution
END FOR
```

### Preservation Checking

**Goal**: Verify that the fixed pipeline produces the same application-level
responses as the intended behaviour of the original pipeline.

**Pseudocode:**

```
FOR ALL X DO
  ASSERT handleRequest_fixed(X).routeResponse
       = handleRequest_original(X).intendedRouteResponse
END FOR
```

**Testing Approach**: Property-based testing is recommended for preservation
checking because:

- It generates many request shapes automatically (varied paths, query strings, bodies)
- It catches edge cases that manual unit tests might miss
- It provides strong guarantees that sanitization behaviour is unchanged across the
  full input domain

**Test Plan**: Observe the intended route behaviour on the fixed code first (since
the unfixed code crashes on every request, there is no "original" baseline to
compare against for route responses). Write property-based tests that generate
random query strings — including strings with and without MongoDB operators — and
assert that sanitization still occurs and routes still respond correctly.

**Test Cases**:

1. **Sanitization Preservation** — generate random query strings containing `$`-prefixed
   keys; assert they are stripped from `req.query` before reaching the route handler
2. **Clean Query Passthrough** — generate random benign query strings; assert they
   arrive at the route handler unchanged
3. **Body Sanitization Preservation** — generate random bodies with MongoDB operators;
   assert `express-mongo-sanitize` still strips them (unaffected by the fix)
4. **Route Response Preservation** — for a set of known valid requests, assert the
   response status and shape match the expected route contract

### Unit Tests

- Test that `patchQueryWritable` middleware sets `req.query` as a writable own
  property before calling `next()`
- Test that after `patchQueryWritable` runs, direct assignment to `req.query` does
  not throw
- Test that `req.query` retains its original value after `patchQueryWritable` runs
- Test edge cases: empty query object, query with `$`-prefixed keys, query with
  nested objects

### Property-Based Tests

- Generate arbitrary query string objects (using `fast-check`) and verify that
  `patchQueryWritable` always produces a writable own property with the same value
- Generate arbitrary request shapes and verify that the full middleware stack
  (patch → sanitize) never throws a TypeError
- Generate query objects with random `$`-prefixed keys and verify that
  `express-mongo-sanitize` still removes them after the patch middleware runs

### Integration Tests

- Full-stack request to `GET /api/products` returns 200 (or auth-gated response),
  not 500
- Full-stack request to `POST /api/auth/login` with valid credentials returns 200
  token, not 500
- Full-stack request with `?$where=1` in query string is sanitized and does not
  crash the pipeline
- Verify that `hpp` (HTTP parameter pollution protection) still operates correctly
  after the fix, since it also interacts with `req.query`
