import test from "node:test";
import assert from "node:assert/strict";

import { currentMonthRange, getQueryValue, parseBooleanQuery, parseOptionalNumber, parsePaginationNumber } from "./httpQuery.js";

// Every route's first contact with untrusted input. Express hands query values
// through as string | string[] | ParsedQs, so the non-string cases below are not
// hypothetical -- `?limit=1&limit=2` really does arrive as an array.

test("getQueryValue trims strings and flattens everything else to empty", () => {
  assert.equal(getQueryValue("  hello  "), "hello");
  assert.equal(getQueryValue(""), "");
  assert.equal(getQueryValue(undefined), "");
  assert.equal(getQueryValue(null), "");
  assert.equal(getQueryValue(42), "", "a number is not a query string");
  assert.equal(getQueryValue(["a", "b"]), "", "a repeated parameter is refused, not silently first-wins");
  assert.equal(getQueryValue({ nested: "x" }), "");
});

test("parsePaginationNumber clamps into [0, max]", () => {
  assert.equal(parsePaginationNumber("10", 25, 100), 10);
  assert.equal(parsePaginationNumber("0", 25, 100), 0);
  assert.equal(parsePaginationNumber("500", 25, 100), 100, "clamped to max");
  assert.equal(parsePaginationNumber("-5", 25, 100), 0, "negatives clamp to zero, never to the fallback");
});

test("parsePaginationNumber falls back on anything non-numeric", () => {
  assert.equal(parsePaginationNumber(undefined, 25, 100), 25);
  assert.equal(parsePaginationNumber("", 25, 100), 25);
  assert.equal(parsePaginationNumber("abc", 25, 100), 25);
  assert.equal(parsePaginationNumber(["1", "2"], 25, 100), 25);
});

test("parsePaginationNumber floors fractional input", () => {
  assert.equal(parsePaginationNumber("10.9", 25, 100), 10);
});

test("parseOptionalNumber accepts only positive finite numbers", () => {
  assert.equal(parseOptionalNumber("7"), 7);
  assert.equal(parseOptionalNumber("2.5"), 2.5);
  assert.equal(parseOptionalNumber("0"), undefined, "zero is not a useful optional bound");
  assert.equal(parseOptionalNumber("-3"), undefined);
  assert.equal(parseOptionalNumber("abc"), undefined);
  assert.equal(parseOptionalNumber(""), undefined);
  assert.equal(parseOptionalNumber(undefined), undefined);
});

test("parseBooleanQuery accepts the affirmative spellings only", () => {
  for (const value of ["1", "true", "TRUE", " yes ", "Yes"]) {
    assert.equal(parseBooleanQuery(value), true, `expected ${JSON.stringify(value)} to be true`);
  }
  for (const value of ["0", "false", "no", "", "maybe", undefined, null, 1, true]) {
    assert.equal(parseBooleanQuery(value), false, `expected ${JSON.stringify(value)} to be false`);
  }
});

test("currentMonthRange spans exactly the current calendar month", () => {
  const { startAt, endAt, month } = currentMonthRange();
  const now = new Date();

  assert.equal(startAt.getDate(), 1);
  assert.equal(startAt.getHours(), 0);
  assert.equal(startAt.getMonth(), now.getMonth());
  assert.equal(startAt.getFullYear(), now.getFullYear());

  // End is the first instant of next month, so the range is half-open.
  assert.equal(endAt.getDate(), 1);
  assert.ok(endAt > startAt);
  assert.ok(endAt > now, "the current month cannot have already ended");

  assert.match(month, /^\d{4}-\d{2}$/);
  assert.equal(month, `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`);
});
