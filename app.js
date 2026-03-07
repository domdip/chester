import { firebaseConfig } from "./firebase-config.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.7.3/firebase-app.js";
import {
  getAuth,
  getRedirectResult,
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  signInWithRedirect,
  signOut,
} from "https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js";
import { doc, getDoc, getFirestore, setDoc } from "https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js";

const DEFAULT_WARMUP_COUNT = 4;
const LONG_TARGET_THRESHOLD_SECONDS = 300;

const defaultState = {
  settings: {
    startDuration: 20,
    successIncreasePct: 20,
    failureMode: "retry",
    failureReducePct: 20,
  },
  nextLongTarget: 20,
  dayPlan: null,
  history: [],
  longSuccessStreak: 0,
  ui: {
    setupCompleted: false,
    setupExpanded: true,
  },
};

let state = makeDefaultState();
let timerInterval = null;
let startedAt = null;
let elapsed = 0;
let running = false;
let awaitingOutcome = false;
let stateDocRef = null;
let currentUid = null;
let saveChain = Promise.resolve();
let auth = null;
let db = null;
let googleProvider = null;

const settingsForm = document.getElementById("settings-form");
const settingsTitleEl = document.getElementById("settings-title");
const settingsToggleBtn = document.getElementById("settings-toggle-btn");
const startDurationRow = document.getElementById("start-duration-row");
const startDurationInput = document.getElementById("start-duration");
const successIncreasePctInput = document.getElementById("success-increase-pct");
const failureModeInput = document.getElementById("failure-mode");
const failureReducePctInput = document.getElementById("failure-reduce-pct");
const targetDurationEl = document.getElementById("target-duration");
const targetBlockEl = document.getElementById("target-block");
const dayTargetDurationEl = document.getElementById("day-target-duration");
const sessionTypeLabelEl = document.getElementById("session-type-label");
const timerEl = document.getElementById("timer");
const sessionControlsEl = document.getElementById("session-controls");
const resultActionsEl = document.getElementById("result-actions");
const completionPanelEl = document.getElementById("completion-panel");
const completionMessageEl = document.getElementById("completion-message");
const nextLongTargetInput = document.getElementById("next-long-target-input");
const nextWarmupCountInput = document.getElementById("next-warmup-count-input");
const startBtn = document.getElementById("start-btn");
const stopBtn = document.getElementById("stop-btn");
const abortSessionBtn = document.getElementById("abort-session-btn");
const newLadderBtn = document.getElementById("new-ladder-btn");
const successBtn = document.getElementById("success-btn");
const struggleBtn = document.getElementById("struggle-btn");
const statusMessage = document.getElementById("status-message");
const historyBody = document.getElementById("history-body");
const rowTemplate = document.getElementById("row-template");
const streakEl = document.getElementById("streak");
const planProgressPill = document.getElementById("plan-progress-pill");
const resetBtn = document.getElementById("reset-btn");
const cloudStatusEl = document.getElementById("cloud-status");
const signInBtn = document.getElementById("sign-in-btn");
const signOutBtn = document.getElementById("sign-out-btn");
const userLabelEl = document.getElementById("user-label");
const settingsSaveBtn = settingsForm.querySelector("button[type='submit']");

bootstrap();

async function bootstrap() {
  bindEvents();
  setUiEnabled(false);
  setStatus("Connecting to Firebase...");

  try {
    await initializeCloud();
    try {
      await getRedirectResult(auth);
    } catch (error) {
      console.error(error);
      setStatus(`Sign-in redirect failed (${error.code || "unknown"}).`);
    }
    onAuthStateChanged(auth, (user) => {
      handleAuthStateChange(user).catch((error) => {
        console.error(error);
        setCloudStatus("Cloud unavailable");
        setStatus(`Auth sync failed (${describeError(error)}).`);
      });
    });
  } catch (error) {
    console.error(error);
    state = makeDefaultState();
    renderSignedOutState();
    setCloudStatus("Cloud unavailable");
    setStatus("Firebase connection failed. Check firebase-config.js and console errors.");
  }
}

function bindEvents() {
  settingsForm.addEventListener("submit", onSaveSettings);
  settingsToggleBtn.addEventListener("click", onToggleSettingsPanel);
  failureModeInput.addEventListener("change", renderFailureSettingsState);
  signInBtn.addEventListener("click", onSignInClick);
  signOutBtn.addEventListener("click", onSignOutClick);
  startBtn.addEventListener("click", onStartSession);
  stopBtn.addEventListener("click", onStopEarly);
  abortSessionBtn.addEventListener("click", onAbortTrainingSession);
  newLadderBtn.addEventListener("click", onNewLadderToday);
  successBtn.addEventListener("click", () => onRecordOutcome("success"));
  struggleBtn.addEventListener("click", () => onRecordOutcome("struggle"));
  resetBtn.addEventListener("click", onResetAll);
}

async function initializeCloud() {
  if (!isFirebaseConfigValid(firebaseConfig)) {
    throw new Error("Missing Firebase config values");
  }

  const app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  db = getFirestore(app);
  googleProvider = new GoogleAuthProvider();
  googleProvider.setCustomParameters({ prompt: "select_account" });
}

async function handleAuthStateChange(user) {
  if (!user) {
    state = makeDefaultState();
    currentUid = null;
    stateDocRef = null;
    renderSignedOutState();
    setCloudStatus("Signed out");
    setStatus("Sign in with Google to load your synced data.");
    return;
  }

  currentUid = user.uid;
  stateDocRef = doc(db, "users", currentUid, "app", "state");
  setAuthUi(true, user.email || user.displayName || user.uid.slice(0, 6));
  setCloudStatus(`Signed in (${currentUid.slice(0, 6)}), loading...`);
  setStatus("Signed in. Loading cloud data...");

  try {
    await loadStateFromCloud();
  } catch (error) {
    console.error(error);
    state = makeDefaultState();
    ensureDayPlan();
    queueSaveState();
    setCloudStatus("Signed in, cloud read failed");
    setStatus(`Signed in, but cloud read failed (${describeError(error)}). Check Firestore rules.`);
  }

  ensureDayPlan();
  populateSettingsForm();
  renderSettingsPanel();
  renderFailureSettingsState();
  renderTimer(0);
  renderPlan();
  renderHistory();
  renderStreak();
  setUiEnabled(true);
  if (!statusMessage.textContent.includes("cloud read failed")) {
    setCloudStatus(`Cloud sync active (${currentUid.slice(0, 6)})`);
    const nextStep = getCurrentSession();
    const lastSession = state.history[0];
    if (nextStep) {
      setStatus("Ready for your next step.");
    } else if (lastSession && isTodayIso(lastSession.date)) {
      setStatus("Today's session is complete. Start a new one anytime.");
    } else if (lastSession) {
      setStatus(`Last session: ${new Date(lastSession.date).toLocaleString()}. Ready for a new one?`);
    } else {
      setStatus("Ready to begin? Start your first session.");
    }
  }
}

function renderSignedOutState() {
  clearInterval(timerInterval);
  running = false;
  awaitingOutcome = false;
  ensureDayPlan();
  populateSettingsForm();
  renderSettingsPanel();
  renderFailureSettingsState();
  renderTimer(0);
  renderPlan();
  renderHistory();
  renderStreak();
  setUiEnabled(false);
  setAuthUi(false, "Not signed in");
}

async function onSignInClick() {
  if (!auth || !googleProvider) return;
  setStatus("Opening Google sign-in...");

  try {
    await signInWithPopup(auth, googleProvider);
    setStatus("Sign-in complete. Loading cloud data...");
    return;
  } catch (error) {
    const code = error?.code || "";
    const shouldFallback =
      code === "auth/popup-blocked" ||
      code === "auth/popup-closed-by-user" ||
      code === "auth/cancelled-popup-request" ||
      code === "auth/operation-not-supported-in-this-environment";

    if (!shouldFallback) {
      console.error(error);
      setStatus(`Popup sign-in failed (${code || "unknown"}).`);
      return;
    }
  }

  setStatus("Popup unavailable. Redirecting to Google sign-in...");
  await signInWithRedirect(auth, googleProvider);
}

async function onSignOutClick() {
  if (!auth) return;
  await signOut(auth);
}

async function loadStateFromCloud() {
  if (!stateDocRef) return;

  const snapshot = await getDoc(stateDocRef);
  if (!snapshot.exists()) {
    state = makeDefaultState();
    queueSaveState();
    return;
  }

  state = sanitizeState(snapshot.data());
}

function queueSaveState() {
  if (!stateDocRef) return;

  const payload = {
    ...state,
    updatedAt: Date.now(),
  };

  saveChain = saveChain
    .then(() => setDoc(stateDocRef, payload))
    .catch((error) => {
      console.error(error);
      setCloudStatus("Cloud save failed");
      setStatus("Save failed. Check network and Firebase rules.");
    });
}

function makeDefaultState() {
  return JSON.parse(JSON.stringify(defaultState));
}

function sanitizeState(raw) {
  const base = makeDefaultState();
  const incoming = raw && typeof raw === "object" ? raw : {};

  const settings = {
    ...base.settings,
    ...(incoming.settings || {}),
  };

  settings.startDuration = clampInt(settings.startDuration, 3, 1800);
  settings.successIncreasePct = clampInt(settings.successIncreasePct, 1, 100);
  settings.failureMode = normalizeFailureMode(settings.failureMode);
  settings.failureReducePct = clampInt(settings.failureReducePct, 1, 100);

  const candidateTarget = Number.isFinite(incoming.nextLongTarget)
    ? incoming.nextLongTarget
    : settings.startDuration;
  const history = Array.isArray(incoming.history) ? incoming.history.slice(0, 500) : [];
  const uiRaw = incoming.ui && typeof incoming.ui === "object" ? incoming.ui : {};
  const hasExistingData = history.length > 0 || incoming.dayPlan !== null;
  const setupCompleted = uiRaw.setupCompleted === true || hasExistingData;
  const setupExpanded = setupCompleted ? false : true;

  return {
    ...base,
    settings,
    nextLongTarget: clampInt(candidateTarget, 3, 7200),
    dayPlan: sanitizeDayPlan(incoming.dayPlan),
    history,
    longSuccessStreak: Number.isFinite(incoming.longSuccessStreak)
      ? Math.max(0, Math.floor(incoming.longSuccessStreak))
      : 0,
    ui: {
      setupCompleted,
      setupExpanded,
    },
  };
}

function sanitizeDayPlan(dayPlan) {
  if (!dayPlan || typeof dayPlan !== "object") return null;

  const sessionsRaw = Array.isArray(dayPlan.sessions) ? dayPlan.sessions : [];
  const derivedWarmupCount = sessionsRaw.filter((session) => session?.kind === "warmup").length;
  const warmupCountFromState = Number.isFinite(dayPlan.warmupCount)
    ? clampInt(dayPlan.warmupCount, 1, 20)
    : clampInt(derivedWarmupCount || DEFAULT_WARMUP_COUNT, 1, 20);
  const sessions = Array.isArray(dayPlan.sessions)
    ? dayPlan.sessions
        .map((session) => ({
          kind: session?.kind === "long-target" ? "long-target" : "warmup",
          duration: clampInt(session?.duration, 1, 7200),
        }))
        .slice(0, warmupCountFromState + 1)
    : [];

  if (sessions.length === 0) return null;

  return {
    sessionId:
      typeof dayPlan.sessionId === "string" && dayPlan.sessionId.trim()
        ? dayPlan.sessionId
        : createSessionId(),
    dateKey: typeof dayPlan.dateKey === "string" ? dayPlan.dateKey : todayKey(),
    targetDuration: clampInt(dayPlan.targetDuration, 3, 7200),
    warmupCount: warmupCountFromState,
    sessions,
    currentIndex: clampInt(dayPlan.currentIndex, 0, sessions.length),
    targetOutcome:
      dayPlan.targetOutcome === "success" || dayPlan.targetOutcome === "struggle"
        ? dayPlan.targetOutcome
        : null,
  };
}

function populateSettingsForm() {
  startDurationInput.value = state.settings.startDuration;
  successIncreasePctInput.value = state.settings.successIncreasePct;
  failureModeInput.value = state.settings.failureMode;
  failureReducePctInput.value = state.settings.failureReducePct;
}

function renderFailureSettingsState() {
  const mode = normalizeFailureMode(failureModeInput.value);
  failureReducePctInput.disabled = mode !== "reduce";
}

function renderSettingsPanel() {
  const uiState = state.ui || defaultState.ui;
  const setupCompleted = !!uiState.setupCompleted;
  const setupExpanded = !setupCompleted || !!uiState.setupExpanded;
  const hasSessions = Array.isArray(state.history) && state.history.length > 0;

  settingsForm.hidden = !setupExpanded;
  settingsToggleBtn.hidden = !setupCompleted;
  startDurationRow.hidden = hasSessions;
  startDurationInput.disabled = hasSessions;
  settingsToggleBtn.setAttribute(
    "aria-label",
    setupExpanded ? "Hide session setup" : "Show session setup"
  );
  settingsTitleEl.textContent = setupExpanded ? "Session Setup" : "Session Setup";
}

function onSaveSettings(event) {
  event.preventDefault();

  const hasSessions = Array.isArray(state.history) && state.history.length > 0;
  const startDuration = hasSessions
    ? clampInt(state.settings.startDuration, 3, 1800)
    : clampInt(startDurationInput.value, 3, 1800);
  const successIncreasePct = clampInt(successIncreasePctInput.value, 1, 100);
  const failureMode = normalizeFailureMode(failureModeInput.value);
  const failureReducePct = clampInt(failureReducePctInput.value, 1, 100);

  state.settings = { startDuration, successIncreasePct, failureMode, failureReducePct };
  state.ui.setupCompleted = true;
  state.ui.setupExpanded = false;

  if (state.history.length === 0) {
    state.nextLongTarget = startDuration;
    regenerateDayPlan();
  }

  queueSaveState();
  renderSettingsPanel();
  renderPlan();
  setStatus("Settings saved.");
}

function onToggleSettingsPanel() {
  if (!state.ui || !state.ui.setupCompleted) return;
  state.ui.setupExpanded = !state.ui.setupExpanded;
  renderSettingsPanel();
  queueSaveState();
}

function onStartSession() {
  if (running) return;

  const session = getCurrentSession();
  if (!session) {
    setStatus("Today's plan is complete. Come back tomorrow.");
    return;
  }

  running = true;
  awaitingOutcome = false;
  elapsed = 0;
  startedAt = Date.now();
  renderPlan();

  setStatus(`Step running (${session.kind}). Stay below threshold.`);
  startBtn.disabled = true;
  stopBtn.disabled = false;
  successBtn.disabled = true;
  struggleBtn.disabled = true;

  timerInterval = setInterval(() => {
    elapsed = Math.floor((Date.now() - startedAt) / 1000);
    renderTimer(elapsed);

    if (elapsed >= session.duration) {
      clearInterval(timerInterval);
      running = false;
      awaitingOutcome = true;
      stopBtn.disabled = true;
      successBtn.disabled = false;
      struggleBtn.disabled = false;
      renderPlan();
      setStatus("Step duration reached. Record calm or stress.");
    }
  }, 250);
}

function onStopEarly() {
  if (!running) return;

  clearInterval(timerInterval);
  running = false;
  awaitingOutcome = true;
  stopBtn.disabled = true;
  successBtn.disabled = false;
  struggleBtn.disabled = false;
  renderPlan();
  setStatus("Step stopped early. Record the observed outcome.");
}

function onNewLadderToday() {
  if (running || awaitingOutcome) {
    setStatus("Finish the active session before starting a new one.");
    return;
  }

  const requestedLongTarget = clampInt(nextLongTargetInput.value, 3, 7200);
  const requestedWarmupCount = clampInt(nextWarmupCountInput.value, 1, 20);
  state.nextLongTarget = requestedLongTarget;

  regenerateDayPlan(requestedWarmupCount);
  awaitingOutcome = false;
  elapsed = 0;
  renderTimer(0);
  renderPlan();
  queueSaveState();
  setStatus(
    `New session plan created. Long target ${formatSeconds(state.nextLongTarget)}, ${requestedWarmupCount} warmups.`
  );
}

function onAbortTrainingSession() {
  const session = getCurrentSession();
  if (!session) {
    setStatus("No active training session to abort.");
    return;
  }

  const shouldAbort = window.confirm("Abort the current training session?");
  if (!shouldAbort) return;

  clearInterval(timerInterval);
  running = false;
  awaitingOutcome = false;
  elapsed = 0;
  renderTimer(0);
  state.dayPlan.currentIndex = state.dayPlan.sessions.length;
  state.dayPlan.targetOutcome = "aborted";

  queueSaveState();
  renderPlan();
  setStatus("Training session aborted. Start a new session when ready.");
}

function onRecordOutcome(outcome) {
  if (running) return;

  const session = getCurrentSession();
  if (!session) return;

  const actual = elapsed;
  const completed = actual >= session.duration;
  const isLongTarget = session.kind === "long-target";

  const notes =
    outcome === "success"
      ? completed
        ? "Calm throughout planned duration."
        : "Calm during shortened run."
      : completed
      ? "Stress signs near/after planned duration."
      : "Stress signs before planned duration.";

  const entry = {
    date: new Date().toISOString(),
    day: state.dayPlan.dateKey,
    sessionId: state.dayPlan.sessionId || createSessionId(),
    phase: isLongTarget ? "Long target" : `Warmup ${state.dayPlan.currentIndex + 1}`,
    target: session.duration,
    actual,
    outcome,
    notes,
  };

  state.history.unshift(entry);

  if (outcome === "success") {
    state.dayPlan.currentIndex += 1;

    if (isLongTarget) {
      const factor = 1 + state.settings.successIncreasePct / 100;
      state.nextLongTarget = Math.min(7200, Math.max(3, Math.round(session.duration * factor)));
      state.longSuccessStreak += 1;
      state.dayPlan.targetOutcome = "success";
      setStatus(
        `Long target succeeded. Next long target set to ${formatSeconds(state.nextLongTarget)}.`
      );
    } else {
      setStatus("Warmup success logged. Move to the next warmup.");
    }
  } else {
    if (isLongTarget) {
      state.longSuccessStreak = 0;
      state.dayPlan.targetOutcome = "struggle";
      state.dayPlan.currentIndex = state.dayPlan.sessions.length;
      applyLongFailurePolicy(session.duration);
    } else {
      state.longSuccessStreak = 0;
      state.dayPlan.targetOutcome = "struggle";
      state.dayPlan.currentIndex = state.dayPlan.sessions.length;
      setStatus("Warmup stress detected. End today's plan and reset tomorrow.");
    }
  }

  queueSaveState();
  awaitingOutcome = false;
  renderPlan();
  renderHistory();
  renderStreak();

  startBtn.disabled = !getCurrentSession();
  successBtn.disabled = true;
  struggleBtn.disabled = true;
  elapsed = 0;
  renderTimer(0);
}

function onResetAll() {
  const shouldReset = window.confirm("Reset settings, plan, and history?");
  if (!shouldReset) return;

  clearInterval(timerInterval);
  state = makeDefaultState();
  running = false;
  awaitingOutcome = false;
  ensureDayPlan();
  queueSaveState();
  populateSettingsForm();
  renderSettingsPanel();
  renderFailureSettingsState();
  renderPlan();
  renderHistory();
  renderStreak();
  renderTimer(0);
  setStatus("All data reset.");
}

function ensureDayPlan() {
  const today = todayKey();

  if (!state.dayPlan || state.dayPlan.dateKey !== today) {
    regenerateDayPlan(getSuggestedWarmupCount());
  }
}

function regenerateDayPlan(warmupCount = DEFAULT_WARMUP_COUNT) {
  const targetDuration = clampInt(state.nextLongTarget, 3, 7200);
  const safeWarmupCount = clampInt(warmupCount, 1, 20);
  state.dayPlan = {
    sessionId: createSessionId(),
    dateKey: todayKey(),
    targetDuration,
    warmupCount: safeWarmupCount,
    sessions: buildSessions(targetDuration, safeWarmupCount),
    currentIndex: 0,
    targetOutcome: null,
  };
}

function buildSessions(targetDuration, warmupCount) {
  const sessions = [];

  for (let i = 0; i < warmupCount; i += 1) {
    const isLongTarget = targetDuration >= LONG_TARGET_THRESHOLD_SECONDS;
    const minWarmup = isLongTarget ? 10 : 1;
    const maxWarmup = isLongTarget
      ? 59
      : Math.max(minWarmup, Math.floor(targetDuration * 0.2));
    const rawDuration = randomInt(minWarmup, maxWarmup);
    const duration = Math.min(targetDuration - 1, rawDuration);

    sessions.push({
      kind: "warmup",
      duration: Math.max(1, duration),
    });
  }

  sessions.push({
    kind: "long-target",
    duration: targetDuration,
  });

  return sessions;
}

function getCurrentSession() {
  if (!state.dayPlan) return null;
  return state.dayPlan.sessions[state.dayPlan.currentIndex] || null;
}

function renderPlan() {
  ensureDayPlan();

  const session = getCurrentSession();
  const completedCount = Math.min(state.dayPlan.currentIndex, state.dayPlan.sessions.length);
  const totalCount = state.dayPlan.sessions.length;

  planProgressPill.textContent = `${completedCount} / ${totalCount} complete today`;
  dayTargetDurationEl.textContent = formatSeconds(state.dayPlan.targetDuration);

  if (session) {
    const warmupIndex = state.dayPlan.currentIndex + 1;
    const warmupCount = state.dayPlan.warmupCount || DEFAULT_WARMUP_COUNT;
    sessionTypeLabelEl.textContent =
      session.kind === "long-target" ? "Long Target Session" : `Warmup ${warmupIndex} of ${warmupCount}`;
    targetDurationEl.textContent = formatSeconds(session.duration);
  } else {
    sessionTypeLabelEl.textContent = "No Active Session";
    targetDurationEl.textContent = "00:00";
  }

  if (session) {
    targetBlockEl.hidden = false;
    timerEl.hidden = false;
    sessionControlsEl.hidden = false;
    resultActionsEl.hidden = false;
    completionPanelEl.hidden = true;

    if (running) {
      startBtn.disabled = true;
      stopBtn.disabled = false;
      abortSessionBtn.disabled = false;
      successBtn.disabled = true;
      struggleBtn.disabled = true;
    } else if (awaitingOutcome) {
      startBtn.disabled = true;
      stopBtn.disabled = true;
      abortSessionBtn.disabled = false;
      successBtn.disabled = false;
      struggleBtn.disabled = false;
    } else {
      startBtn.disabled = startDurationInput.disabled;
      stopBtn.disabled = true;
      abortSessionBtn.disabled = startDurationInput.disabled;
      successBtn.disabled = true;
      struggleBtn.disabled = true;
    }
    return;
  }

  targetBlockEl.hidden = true;
  timerEl.hidden = true;
  sessionControlsEl.hidden = true;
  resultActionsEl.hidden = true;
  completionPanelEl.hidden = false;

  const lastSession = state.history[0];
  if (lastSession && isTodayIso(lastSession.date)) {
    completionMessageEl.textContent = "Congrats on doing today's session!";
  } else if (lastSession) {
    completionMessageEl.textContent = `Last session: ${new Date(lastSession.date).toLocaleString()}. Ready for a new one?`;
  } else {
    completionMessageEl.textContent = "Ready to begin? Start your first session.";
  }
  newLadderBtn.textContent = "Start New Session";
  nextLongTargetInput.value = String(clampInt(state.nextLongTarget, 3, 7200));
  nextWarmupCountInput.value = String(getSuggestedWarmupCount());
  nextLongTargetInput.disabled = startDurationInput.disabled;
  nextWarmupCountInput.disabled = startDurationInput.disabled;

  newLadderBtn.disabled = startDurationInput.disabled;
}

function renderTimer(seconds) {
  timerEl.textContent = formatSeconds(seconds);
}

function renderStreak() {
  streakEl.textContent = `Long-session calm streak: ${state.longSuccessStreak}`;
}

function renderHistory() {
  historyBody.innerHTML = "";

  const sessionGroups = buildSessionGroups(state.history).slice(0, 100);
  sessionGroups.forEach((group) => {
    const latestEntry = group.entries[0];
    const longTargetEntry = group.entries.find((entry) => isLongTargetPhase(entry.phase));
    const warmups = group.entries
      .filter((entry) => parseWarmupIndex(entry.phase) !== null)
      .sort((a, b) => parseWarmupIndex(a.phase) - parseWarmupIndex(b.phase));

    const row = rowTemplate.content.cloneNode(true);
    row.querySelector(".date").textContent = new Date(latestEntry.date).toLocaleString();
    row.querySelector(".target").textContent = longTargetEntry ? formatSeconds(longTargetEntry.target) : "-";
    row.querySelector(".actual").textContent = longTargetEntry ? formatSeconds(longTargetEntry.actual) : "-";

    const outcomeCell = row.querySelector(".outcome");
    let outcomeText = "In progress";
    let outcomeClass = "neutral";

    if (longTargetEntry) {
      outcomeText = longTargetEntry.outcome === "success" ? "Calm" : "Stress";
      outcomeClass = longTargetEntry.outcome;
    } else if (latestEntry.outcome === "struggle") {
      outcomeText = "Stress";
      outcomeClass = "struggle";
    }
    outcomeCell.textContent = outcomeText;
    outcomeCell.className = `outcome ${outcomeClass}`;

    row.querySelector(".notes").textContent = longTargetEntry ? longTargetEntry.notes : latestEntry.notes;

    const warmupToggleBtn = row.querySelector(".warmup-toggle");
    const warmupRow = row.querySelector(".history-warmups-row");
    const warmupList = row.querySelector(".warmup-list");

    if (warmups.length === 0) {
      warmupToggleBtn.textContent = "No warmups";
      warmupToggleBtn.disabled = true;
    } else {
      warmupToggleBtn.textContent = `Show warmups (${warmups.length})`;
      warmups.forEach((warmupEntry) => {
        const warmupOutcome = warmupEntry.outcome === "success" ? "Calm" : "Stress";
        const warmupIndex = parseWarmupIndex(warmupEntry.phase) || 0;
        const item = document.createElement("li");
        item.textContent = `Warmup ${warmupIndex}: ${formatSeconds(warmupEntry.actual)} / ${formatSeconds(
          warmupEntry.target
        )} (${warmupOutcome})`;
        warmupList.appendChild(item);
      });

      warmupToggleBtn.addEventListener("click", () => {
        const isExpanded = warmupToggleBtn.getAttribute("aria-expanded") === "true";
        warmupToggleBtn.setAttribute("aria-expanded", isExpanded ? "false" : "true");
        warmupToggleBtn.textContent = isExpanded
          ? `Show warmups (${warmups.length})`
          : `Hide warmups (${warmups.length})`;
        warmupRow.hidden = isExpanded;
      });
    }

    historyBody.appendChild(row);
  });
}

function buildSessionGroups(history) {
  if (!Array.isArray(history) || history.length === 0) return [];

  const groups = [];
  let index = 0;

  while (index < history.length) {
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
      groups.push({ entries });
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

    groups.push({ entries });
  }

  return groups;
}

function setStatus(message) {
  statusMessage.textContent = message;
}

function setCloudStatus(message) {
  if (cloudStatusEl) {
    cloudStatusEl.textContent = message;
  }
}

function setUiEnabled(enabled) {
  startDurationInput.disabled = !enabled;
  successIncreasePctInput.disabled = !enabled;
  failureModeInput.disabled = !enabled;
  failureReducePctInput.disabled = !enabled || normalizeFailureMode(failureModeInput.value) !== "reduce";
  resetBtn.disabled = !enabled;
  settingsSaveBtn.disabled = !enabled;
  settingsToggleBtn.disabled = !enabled;
  startBtn.disabled = !enabled;
  stopBtn.disabled = true;
  abortSessionBtn.disabled = !enabled;
  newLadderBtn.disabled = !enabled;
  successBtn.disabled = true;
  struggleBtn.disabled = true;
}

function setAuthUi(isSignedIn, label) {
  signInBtn.disabled = isSignedIn;
  signOutBtn.disabled = !isSignedIn;
  userLabelEl.textContent = isSignedIn ? `Signed in: ${label}` : label;
}

function formatSeconds(totalSeconds) {
  const minutes = Math.floor(totalSeconds / 60)
    .toString()
    .padStart(2, "0");
  const seconds = Math.floor(totalSeconds % 60)
    .toString()
    .padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function clampInt(value, min, max) {
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function randomInt(min, max) {
  if (max <= min) return min;
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function describeError(error) {
  if (!error) return "unknown";
  if (typeof error === "string") return error;

  const code = typeof error.code === "string" && error.code.trim() ? error.code.trim() : "";
  const message = typeof error.message === "string" && error.message.trim() ? error.message.trim() : "";

  if (code && message) return `${code}: ${message}`;
  if (code) return code;
  if (message) return message;
  return "unknown";
}

function createSessionId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function isoDayFromDate(isoDate) {
  const date = new Date(isoDate);
  if (Number.isNaN(date.getTime())) return "";
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function isLongTargetPhase(phase) {
  return /^Long target/i.test(String(phase || ""));
}

function parseWarmupIndex(phase) {
  const match = /^Warmup\s+(\d+)/i.exec(String(phase || ""));
  return match ? clampInt(match[1], 1, 20) : null;
}

function todayKey() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function isTodayIso(isoDate) {
  const date = new Date(isoDate);
  const now = new Date();
  return (
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  );
}

function getSuggestedWarmupCount() {
  if (!Array.isArray(state.history) || state.history.length === 0) {
    return DEFAULT_WARMUP_COUNT;
  }

  if (state.dayPlan && Number.isFinite(state.dayPlan.warmupCount)) {
    return clampInt(state.dayPlan.warmupCount, 1, 20);
  }

  const latestDay = state.history[0]?.day;
  if (!latestDay) return DEFAULT_WARMUP_COUNT;

  let maxWarmup = 0;
  for (const entry of state.history) {
    if (entry.day !== latestDay) break;
    const warmupIndex = parseWarmupIndex(entry.phase);
    if (warmupIndex !== null) maxWarmup = Math.max(maxWarmup, warmupIndex);
  }

  return maxWarmup > 0 ? maxWarmup : DEFAULT_WARMUP_COUNT;
}

function normalizeFailureMode(value) {
  return value === "reduce" ? "reduce" : "retry";
}

function applyLongFailurePolicy(currentTarget) {
  const mode = normalizeFailureMode(state.settings.failureMode);

  if (mode === "reduce") {
    const factor = 1 - state.settings.failureReducePct / 100;
    state.nextLongTarget = Math.max(3, Math.round(currentTarget * factor));
    setStatus(
      `Long target struggled. Next long target reduced to ${formatSeconds(state.nextLongTarget)}.`
    );
    return;
  }

  if (mode === "retry") {
    state.nextLongTarget = currentTarget;
    setStatus("Long target struggled. Same long target will be retried tomorrow.");
    return;
  }
}

function isFirebaseConfigValid(config) {
  const required = ["apiKey", "authDomain", "projectId", "appId"];
  return !!config && required.every((key) => typeof config[key] === "string" && config[key].trim());
}
