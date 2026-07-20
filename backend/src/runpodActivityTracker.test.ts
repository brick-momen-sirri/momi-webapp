import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import {
  beginRunpodBillableOperation,
  hasExclusiveRunpodActivityWindow,
  resetRunpodActivityTracking,
  runpodActivityBaseline,
} from "./runpodActivityTracker.js";

beforeEach(() => {
  resetRunpodActivityTracking();
});

test("window is exclusive when a single operation runs alone", () => {
  const end = beginRunpodBillableOperation();
  const baseline = runpodActivityBaseline();

  assert.equal(hasExclusiveRunpodActivityWindow(baseline), true);
  end();
});

test("window is tainted when another operation is already active at baseline", () => {
  const endOther = beginRunpodBillableOperation();
  const endOwn = beginRunpodBillableOperation();
  const baseline = runpodActivityBaseline();

  assert.equal(hasExclusiveRunpodActivityWindow(baseline), false);
  endOther();
  endOwn();
});

test("window is tainted when another operation starts during it", () => {
  const endOwn = beginRunpodBillableOperation();
  const baseline = runpodActivityBaseline();

  const endOther = beginRunpodBillableOperation();
  assert.equal(hasExclusiveRunpodActivityWindow(baseline), false);
  endOther();
  endOwn();
});

test("window stays tainted after the overlapping operation ends", () => {
  const endOwn = beginRunpodBillableOperation();
  const baseline = runpodActivityBaseline();

  const endOther = beginRunpodBillableOperation();
  endOther();

  assert.equal(hasExclusiveRunpodActivityWindow(baseline), false);
  endOwn();
});

test("sequential non-overlapping operations each get exclusive windows", () => {
  const endFirst = beginRunpodBillableOperation();
  const firstBaseline = runpodActivityBaseline();
  assert.equal(hasExclusiveRunpodActivityWindow(firstBaseline), true);
  endFirst();

  const endSecond = beginRunpodBillableOperation();
  const secondBaseline = runpodActivityBaseline();
  assert.equal(hasExclusiveRunpodActivityWindow(secondBaseline), true);
  endSecond();
});

test("end callback is idempotent", () => {
  const endFirst = beginRunpodBillableOperation();
  endFirst();
  endFirst();
  endFirst();

  const endSecond = beginRunpodBillableOperation();
  const baseline = runpodActivityBaseline();
  assert.equal(baseline.activeOperations, 1);
  assert.equal(hasExclusiveRunpodActivityWindow(baseline), true);
  endSecond();
});

test("nested operations from the same flow taint a concurrent job window", () => {
  // A queue job begins, then a prompt-helper flow (which wraps itself and its
  // internal describe-image fallback) runs concurrently.
  const endJob = beginRunpodBillableOperation();
  const jobBaseline = runpodActivityBaseline();

  const endPromptFlow = beginRunpodBillableOperation();
  const endNestedFallback = beginRunpodBillableOperation();
  endNestedFallback();
  endPromptFlow();

  assert.equal(hasExclusiveRunpodActivityWindow(jobBaseline), false);
  endJob();
});
