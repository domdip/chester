export function clampInt(value, min, max) {
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n)) return min;
  return Math.max(min, Math.min(max, n));
}

export function randomInt(min, max) {
  if (max <= min) return min;
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export function isoDayFromDate(isoDate) {
  const date = new Date(isoDate);
  if (Number.isNaN(date.getTime())) return "";
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function todayKey() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function isLongTargetPhase(phase) {
  return /^Long target/i.test(String(phase || ""));
}

export function parseWarmupIndex(phase) {
  const match = /^Warmup\s+(\d+)/i.exec(String(phase || ""));
  return match ? clampInt(match[1], 1, 20) : null;
}

export function normalizeFailureMode(value) {
  if (value === "reduce" || value === "retry" || value === "last-success") return value;
  return "reduce";
}

export function parseOutcomeInput(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (normalized === "calm" || normalized === "success") return "success";
  if (normalized === "stress" || normalized === "struggle") return "struggle";
  return null;
}

export function buildSessionGroups(history) {
  if (!Array.isArray(history) || history.length === 0) return [];

  const groups = [];
  let index = 0;

  while (index < history.length) {
    const groupStartIndex = index;
    const startEntry = history[index];
    if (!startEntry || typeof startEntry !== "object") {
      index += 1;
      continue;
    }

    if (startEntry.sessionId) {
      const entries = [startEntry];
      index += 1;
      while (index < history.length && history[index]?.sessionId === startEntry.sessionId) {
        entries.push(history[index]);
        index += 1;
      }
      groups.push({ entries, startIndex: groupStartIndex, count: entries.length });
      continue;
    }

    const entries = [startEntry];
    const startDay = startEntry.day || isoDayFromDate(startEntry.date);
    let warmupCursor = parseWarmupIndex(startEntry.phase);

    index += 1;
    while (index < history.length) {
      const candidate = history[index];
      if (!candidate || typeof candidate !== "object") break;
      if (candidate.sessionId) break;

      const candidateDay = candidate.day || isoDayFromDate(candidate.date);
      if (candidateDay !== startDay) break;

      const candidateWarmup = parseWarmupIndex(candidate.phase);
      if (candidateWarmup === null) break;
      if (warmupCursor !== null && candidateWarmup >= warmupCursor) break;

      entries.push(candidate);
      warmupCursor = candidateWarmup;
      index += 1;

      if (candidateWarmup === 1) break;
    }

    groups.push({ entries, startIndex: groupStartIndex, count: entries.length });
  }

  return groups;
}

export function calculateLongSuccessStreak(history) {
  let streak = 0;
  for (const entry of history || []) {
    if (!isLongTargetPhase(entry.phase)) continue;
    if (entry.outcome === "success") {
      streak += 1;
      continue;
    }
    break;
  }
  return streak;
}

export function pickNewerState(cloudState, localState) {
  if (!localState) return cloudState;
  const cloudUpdatedAt = Number.isFinite(cloudState?.updatedAt) ? cloudState.updatedAt : 0;
  const localUpdatedAt = Number.isFinite(localState?.updatedAt) ? localState.updatedAt : 0;
  return localUpdatedAt > cloudUpdatedAt ? localState : cloudState;
}

export function resolvePreferredState(cloudState, localState) {
  if (!localState) return { state: cloudState, source: "cloud" };
  const preferred = pickNewerState(cloudState, localState);
  const source = preferred === localState ? "local" : "cloud";
  return { state: preferred, source };
}

export function getCalmTargetSeries(history) {
  return (history || [])
    .filter((entry) => isLongTargetPhase(entry.phase) && entry.outcome === "success")
    .map((entry) => ({
      date: entry.date,
      target: clampInt(entry.target, 1, 7200),
    }))
    .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
}

export function getLongestCalmTarget(history) {
  const calmSeries = getCalmTargetSeries(history);
  if (calmSeries.length === 0) return null;
  return calmSeries.reduce((max, entry) => Math.max(max, entry.target), 0);
}
