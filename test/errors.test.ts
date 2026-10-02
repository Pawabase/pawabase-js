import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ApiError,
  AuthenticationError,
  ConflictError,
  NotFoundError,
  PermissionError,
  RateLimitError,
  ServerError,
  ValidationError,
  errorFromResponse,
  parseRetryAfter,
} from "../src/errors.js";

const headers = (values: Record<string, string> = {}) => new Headers({ "x-request-id": "req-1", ...values });

test("a bare string body becomes the message and a status-derived code", () => {
  const error = errorFromResponse({ status: 401, body: "Authentication required", headers: headers() });
  assert.ok(error instanceof AuthenticationError);
  assert.equal(error.message, "Authentication required");
  assert.equal(error.code, "unauthenticated");
  assert.equal(error.requestId, "req-1");
});

test("a refusing policy is named", () => {
  const error = errorFromResponse({ status: 403, body: "policy 'org_admin' refused", headers: headers() });
  assert.ok(error instanceof PermissionError);
  assert.equal(error.policy, "org_admin");
});

test("a 422 bare array of issues becomes a ValidationError with fields", () => {
  const error = errorFromResponse({
    status: 422,
    headers: headers(),
    body: [
      { type: "missing", loc: ["body", "title"], msg: "Field required", input: {} },
      { type: "string_type", loc: ["body", "meta", "tag"], msg: "Input should be a valid string" },
    ],
  });
  assert.ok(error instanceof ValidationError);
  assert.deepEqual(error.byField(), {
    title: ["Field required"],
    "meta.tag": ["Input should be a valid string"],
  });
  assert.equal(error.fieldError("title"), "Field required");
  assert.match(error.message, /title: Field required/);
});

test("query validation errors under detail are issues too", () => {
  const error = errorFromResponse({
    status: 422,
    headers: headers(),
    body: { detail: [{ loc: ["query", "per_page"], msg: "Input should be less than or equal to 200", type: "less_than_equal" }] },
  });
  assert.ok(error instanceof ValidationError);
  assert.equal(error.issues[0]?.field, "per_page");
});

test("gateway errors keep their code and Retry-After", () => {
  const error = errorFromResponse({
    status: 429,
    headers: headers({ "retry-after": "7" }),
    body: { error: "rate_limit_exceeded", retry_after: 7 },
  });
  assert.ok(error instanceof RateLimitError);
  assert.equal(error.code, "rate_limit_exceeded");
  assert.equal(error.retryAfter, 7);
  assert.ok(error.is("rate_limit_exceeded"));

  const key = errorFromResponse({
    status: 401,
    headers: headers(),
    body: { error: "invalid_api_key", message: "Send a valid project API key in the apikey header." },
  });
  assert.equal(key.code, "invalid_api_key");
  assert.equal(key.message, "Send a valid project API key in the apikey header.");
});

test("flow and function errors carry details", () => {
  const error = errorFromResponse({
    status: 502,
    headers: headers(),
    body: { error: "upstream_failed", message: "payments said no", details: { attempt: 2 } },
  });
  assert.ok(error instanceof ServerError);
  assert.equal(error.code, "upstream_failed");
  assert.deepEqual(error.details, { attempt: 2 });
});

test("404 and 409 map to their classes; unknown statuses stay ApiError", () => {
  assert.ok(errorFromResponse({ status: 404, body: "Not found" }) instanceof NotFoundError);
  assert.ok(errorFromResponse({ status: 409, body: "that email is in use" }) instanceof ConflictError);
  const teapot = errorFromResponse({ status: 418, body: undefined });
  assert.ok(teapot instanceof ApiError);
  assert.equal(teapot.message, "Request failed with status 418.");
  assert.equal(teapot.code, "http_error");
});

test("Retry-After accepts seconds and HTTP dates", () => {
  assert.equal(parseRetryAfter("12"), 12);
  const now = Date.parse("2026-01-01T00:00:00Z");
  assert.equal(parseRetryAfter("Thu, 01 Jan 2026 00:00:30 GMT", now), 30);
  assert.equal(parseRetryAfter("nonsense"), null);
  assert.equal(parseRetryAfter(null), null);
});
