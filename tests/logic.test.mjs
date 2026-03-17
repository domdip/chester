import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSessionGroups,
  calculateLongSuccessStreak,
  clampInt,
  getCalmTargetSeries,
  getLongestCalmTarget,
  isoDayFromDate,
  normalizeFailureMode,
  parseOutcomeInput,
  parseWarmupIndex,
  resolvePreferredState,
} from "../logic.mjs";

test("clampInt coerces invalid and out-of-range values safely", () => {
  assert.equal(clampInt("18", 3, 20), 18);
  assert.equal(clampInt("nope", 3, 20), 3);
  assert.equal(clampInt(99, 3, 20), 20);
});

test("isoDayFromDate returns yyyy-mm-dd for valid dates and empty string for invalid", () => {
  assert.equal(isoDayFromDate("2026-03-09T18:30:00.000Z"), "2026-03-09");
  assert.equal(isoDayFromDate("invalid"), "");
});

test("parseWarmupIndex extracts warmup numbers and rejects non-warmup phases", () => {
  assert.equal(parseWarmupIndex("Warmup 3"), 3);
  assert.equal(parseWarmupIndex("warmup 12"), 12);
  assert.equal(parseWarmupIndex("Long target"), null);
});

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

test("buildSessionGroups falls back to day and descending warmup order when sessionId is missing", () => {
  const history = [
    { phase: "Long target", day: "2026-03-07" },
    { phase: "Warmup 2", day: "2026-03-07" },
    { phase: "Warmup 1", day: "2026-03-07" },
    { phase: "Long target", day: "2026-03-06" },
  ];
  const groups = buildSessionGroups(history);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map((g) => g.count), [3, 1]);
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

test("getCalmTargetSeries returns sorted successful long-target entries with clamped targets", () => {
  const history = [
    { phase: "Long target", outcome: "success", target: 9000, date: "2026-03-03T00:00:00.000Z" },
    { phase: "Warmup 1", outcome: "success", target: 30, date: "2026-03-02T00:00:00.000Z" },
    { phase: "Long target", outcome: "success", target: 500, date: "2026-03-01T00:00:00.000Z" },
  ];
  assert.deepEqual(getCalmTargetSeries(history), [
    { date: "2026-03-01T00:00:00.000Z", target: 500 },
    { date: "2026-03-03T00:00:00.000Z", target: 7200 },
  ]);
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
