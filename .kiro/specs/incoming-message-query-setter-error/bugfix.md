# Bugfix Requirements Document

## Introduction

Any incoming HTTP request to the ShopNest API returns a 500 error with the message
`TypeError: Cannot set property query of #<IncomingMessage> which has only a getter`.

The root cause is a compatibility break between `express-mongo-sanitize` (v2.x) and
Express 5. In Express 5, `req.query` is defined as a read-only getter on the
`IncomingMessage` prototype. The `express-mongo-sanitize` middleware iterates over
`['body', 'params', 'headers', 'query']` and performs a direct assignment
`req[key] = target` after sanitizing each property. When `key` is `'query'`, this
assignment throws a `TypeError` because the property has no setter, crashing the
request pipeline before any route handler is reached.

The fix must make `req.query` writable before `express-mongo-sanitize` runs, so the
sanitizer can complete its assignment without throwing, while leaving all other
middleware and route behaviour unchanged.

---

## Bug Analysis

### Current Behavior (Defect)

1.1 WHEN any HTTP request is received by the Express 5 application THEN the system
    crashes with `TypeError: Cannot set property query of #<IncomingMessage> which
    has only a getter` before reaching any route handler

1.2 WHEN `express-mongo-sanitize` middleware executes and attempts `req.query = target`
    THEN the system throws a `TypeError` because `req.query` is a read-only getter in
    Express 5

1.3 WHEN the `TypeError` is thrown inside the middleware pipeline THEN the system
    returns HTTP 500 to the caller instead of the expected route response

### Expected Behavior (Correct)

2.1 WHEN any HTTP request is received THEN the system SHALL process the request
    through the full middleware pipeline without throwing a `TypeError` on `req.query`

2.2 WHEN `express-mongo-sanitize` middleware executes THEN the system SHALL allow the
    sanitizer to assign to `req.query` without error by ensuring `req.query` is
    writable before the sanitizer runs

2.3 WHEN a request reaches a route handler THEN the system SHALL return the expected
    HTTP response (e.g. 200, 201, 400, 401) instead of a 500 error

### Unchanged Behavior (Regression Prevention)

3.1 WHEN a request body, params, or headers contain MongoDB operator keys (e.g. `$where`,
    `$gt`) THEN the system SHALL CONTINUE TO sanitize those fields via
    `express-mongo-sanitize`

3.2 WHEN a request query string contains MongoDB operator keys THEN the system SHALL
    CONTINUE TO sanitize those query parameters via `express-mongo-sanitize`

3.3 WHEN a request does not contain any MongoDB operator keys THEN the system SHALL
    CONTINUE TO pass `req.query`, `req.body`, `req.params`, and `req.headers` through
    unchanged to route handlers

3.4 WHEN a valid authenticated request is made to any existing route THEN the system
    SHALL CONTINUE TO return the same response it returned before the fix

---

## Bug Condition

### Bug Condition Function

```pascal
FUNCTION isBugCondition(X)
  INPUT: X — any incoming HTTP request handled by the Express 5 application
  OUTPUT: boolean

  // The bug fires unconditionally on every request because express-mongo-sanitize
  // always iterates over ['body', 'params', 'headers', 'query'] and always attempts
  // req['query'] = target, regardless of whether the query string contains
  // prohibited keys.
  RETURN true
END FUNCTION
```

### Property: Fix Checking

```pascal
// Property 1: Fix Checking — No TypeError on req.query assignment
FOR ALL X WHERE isBugCondition(X) DO
  result ← handleRequest'(X)   // F' = fixed middleware pipeline
  ASSERT result.statusCode ≠ 500
  ASSERT no TypeError thrown during middleware execution
END FOR
```

### Property: Preservation Checking

```pascal
// Property 2: Preservation — Existing route behaviour unchanged
FOR ALL X WHERE NOT isBugCondition(X) DO
  // isBugCondition is always true, so this set is empty.
  // Preservation is expressed as: for all well-formed requests,
  // F'(X) produces the same application-level response as the
  // intended behaviour of F(X) (i.e. the route handler response,
  // not the crash).
  ASSERT F(X).routeResponse = F'(X).routeResponse
END FOR
```
