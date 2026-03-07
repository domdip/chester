import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSessionGroups,
  calculateLongSuccessStreak,
  getLongestCalmTarget,
  normalizeFailureMode,
  parseOutcomeInput,
  resolvePreferredState,
} from "../logic.mjs";

test("normalizeFailureMode defaults unknown values to reduce", () => {
  assert.equal(normalizeFailureMode("weird"), "reduce");
  assert.equal(normalizeFailureMode("retry"), "retry");
  assert.equal(normalizeFailureMode("last-success"), "last-success");
});

test("parseOutcomeInput maps calm/stress aliases", () => {
  assert.equal(parseOutcomeInput("calm"), "success");
  assert.equal(parseOutcomeInput("success"), "success");
  assert.equal(parseOutcomeInput("stress"), "struggle");
  assert.equal(parseOutcomeInput("struggle"), "struggle");
  assert.equal(parseOutcomeInput("other"), null);
});

test("resolvePreferredState selects local when local is newer", () => {
  const cloudState = { updatedAt: 100, value: "cloud" };
  const localState = { updatedAt: 200, value: "local" };
  const resolved = resolvePreferredState(cloudState, localState);
  assert.equal(resolved.source, "local");
  assert.equal(resolved.state.value, "local");
});

test("buildSessionGroups groups by sessionId and includes start/count", () => {
  const history = [
    { sessionId: "a", phase: "Long target", day: "2026-03-07" },
    { sessionId: "a", phase: "Warmup 1", day: "2026-03-07" },
    { sessionId: "b", phase: "Long target", day: "2026-03-06" },
  ];
  const groups = buildSessionGroups(history);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map((g) => g.count), [2, 1]);
  assert.deepEqual(groups.map((g) => g.startIndex), [0, 2]);
});

test("calculateLongSuccessStreak counts contiguous long-target successes from newest", () => {
  const history = [
    { phase: "Long target", outcome: "success" },
    { phase: "Warmup 1", outcome: "success" },
    { phase: "Long target", outcome: "success" },
    { phase: "Long target", outcome: "struggle" },
  ];
  assert.equal(calculateLongSuccessStreak(history), 2);
});

test("getLongestCalmTarget returns max successful long-target duration", () => {
  const history = [
    { phase: "Long target", outcome: "success", target: 500, date: "2026-03-01T00:00:00.000Z" },
    { phase: "Long target", outcome: "struggle", target: 600, date: "2026-03-02T00:00:00.000Z" },
    { phase: "Long target", outcome: "success", target: 540, date: "2026-03-03T00:00:00.000Z" },
  ];
  assert.equal(getLongestCalmTarget(history), 540);
  assert.equal(getLongestCalmTarget([]), null);
});
