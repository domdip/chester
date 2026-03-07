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
import { Chart, registerables } from "https://cdn.jsdelivr.net/npm/chart.js@4.4.7/+esm";

const DEFAULT_WARMUP_COUNT = 4;
const LONG_TARGET_THRESHOLD_SECONDS = 300;
const LOCAL_STATE_KEY_PREFIX = "separation-training-state-v1";

const defaultState = {
  settings: {
    startDuration: 20,
    successIncreasePct: 20,
    failureMode: "reduce",
    failureReducePct: 10,
  },
  nextLongTarget: 20,
  dayPlan: null,
  history: [],
  longSuccessStreak: 0,
  updatedAt: 0,
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
let calmTrendChart = null;

Chart.register(...registerables);

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
const longestCalmTargetEl = document.getElementById("longest-calm-target");
const calmTrendEl = document.getElementById("calm-trend");
const calmTrendChartEl = document.getElementById("calm-trend-chart");
const planProgressPill = document.getElementById("plan-progress-pill");
const resetBtn = document.getElementById("reset-btn");
const cloudStatusEl = document.getElementById("cloud-status");
const signInBtn = document.getElementById("sign-in-btn");
const signOutBtn = document.getElementById("sign-out-btn");
const userLabelEl = document.getElementById("user-label");
const deployStampEl = document.getElementById("deploy-stamp");
const settingsSaveBtn = settingsForm.querySelector("button[type='submit']");

bootstrap();

async function bootstrap() {
  bindEvents();
  renderDeployStamp();
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
    onAuthStateChanged(
      auth,
      (user) => {
        handleAuthStateChange(user).catch((error) => {
          console.error(error);
          setCloudStatus("Cloud unavailable");
          setStatus(`Auth sync failed (${describeError(error)}).`);
        });
      },
      (error) => {
        console.error(error);
        setCloudStatus("Cloud unavailable");
        setStatus(`Auth state listener failed (${describeError(error)}).`);
      }
    );
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
  const localBackupState = loadLocalBackupState(currentUid);

  try {
    const cloudState = await loadStateFromCloud();
    if (cloudState) {
      state = pickNewerState(cloudState, localBackupState);
    } else if (localBackupState) {
      state = localBackupState;
      queueSaveState();
      setStatus("Cloud state missing. Restored from local backup.");
    } else {
      state = makeDefaultState();
      queueSaveState();
    }
  } catch (error) {
    console.error(error);
    if (localBackupState) {
      state = localBackupState;
      setCloudStatus("Cloud read failed, using local backup");
      setStatus(`Cloud read failed (${describeError(error)}). Restored local backup and will retry sync.`);
      queueSaveState();
    } else {
      state = makeDefaultState();
      ensureDayPlan();
      queueSaveState();
      setCloudStatus("Signed in, cloud read failed");
      setStatus(`Signed in, but cloud read failed (${describeError(error)}). Check Firestore rules.`);
    }
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
    return null;
  }

  return sanitizeState(snapshot.data());
}

function queueSaveState() {
  const payload = {
    ...state,
    updatedAt: Date.now(),
  };
  state.updatedAt = payload.updatedAt;
  persistLocalBackupState(currentUid, payload);
  if (!stateDocRef) return;

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
  const history = Array.isArray(incoming.history)
    ? incoming.history.slice(0, 500).map(sanitizeHistoryEntry).filter(Boolean)
    : [];
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
    updatedAt: Number.isFinite(incoming.updatedAt) ? Math.max(0, Math.floor(incoming.updatedAt)) : 0,
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
  const abortedActual = elapsed;
  running = false;
  awaitingOutcome = false;
  elapsed = 0;
  renderTimer(0);

  state.history.unshift({
    date: new Date().toISOString(),
    day: state.dayPlan.dateKey,
    sessionId: state.dayPlan.sessionId || createSessionId(),
    phase: session.kind === "long-target" ? "Long target" : `Warmup ${state.dayPlan.currentIndex + 1}`,
    target: session.duration,
    actual: Math.max(0, abortedActual),
    outcome: "aborted",
    notes: "Session aborted by user.",
  });

  state.dayPlan.currentIndex = state.dayPlan.sessions.length;
  state.dayPlan.targetOutcome = "aborted";

  queueSaveState();
  renderPlan();
  renderHistory();
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
  if (longestCalmTargetEl) {
    const longestCalmTarget = getLongestCalmTarget();
    longestCalmTargetEl.textContent = `Longest calm target: ${
      longestCalmTarget === null ? "--:--" : formatSeconds(longestCalmTarget)
    }`;
  }
  try {
    renderCalmTrend();
  } catch (error) {
    console.error(error);
    if (calmTrendEl) calmTrendEl.hidden = true;
    if (calmTrendChart) {
      calmTrendChart.destroy();
      calmTrendChart = null;
    }
  }
}

function renderDeployStamp() {
  if (!deployStampEl) return;

  const loadedAt = new Date().toLocaleString();
  const pageModified =
    typeof document.lastModified === "string" && document.lastModified.trim()
      ? new Date(document.lastModified)
      : null;
  const isValidModified = pageModified instanceof Date && !Number.isNaN(pageModified.getTime());
  const modifiedText = isValidModified ? pageModified.toLocaleString() : "unknown";

  deployStampEl.textContent = `Deployment stamp: ${modifiedText} | Loaded: ${loadedAt}`;
}

function renderHistory() {
  if (!historyBody || !rowTemplate) return;
  historyBody.innerHTML = "";

  const sessionGroups = buildSessionGroups(state.history).slice(0, 100);
  sessionGroups.forEach((group) => {
    const latestEntry = group.entries[0];
    const longTargetEntry = group.entries.find((entry) => isLongTargetPhase(entry.phase));
    const warmups = group.entries
      .filter((entry) => parseWarmupIndex(entry.phase) !== null)
      .sort((a, b) => parseWarmupIndex(a.phase) - parseWarmupIndex(b.phase));

    const row = rowTemplate.content.cloneNode(true);
    setCellText(row, ".date", new Date(latestEntry.date).toLocaleString());
    setCellText(row, ".target", longTargetEntry ? formatSeconds(longTargetEntry.target) : "-");
    setCellText(row, ".actual", longTargetEntry ? formatSeconds(longTargetEntry.actual) : "-");
    setCellText(row, ".phase", longTargetEntry ? "Long target" : latestEntry.phase || "-");

    const outcomeCell = row.querySelector(".outcome");
    let outcomeText = "In progress";
    let outcomeClass = "neutral";

    if (longTargetEntry) {
      if (longTargetEntry.outcome === "success") {
        outcomeText = "Calm";
        outcomeClass = "success";
      } else if (longTargetEntry.outcome === "aborted") {
        outcomeText = "Aborted";
        outcomeClass = "aborted";
      } else {
        outcomeText = "Stress";
        outcomeClass = "struggle";
      }
    } else if (latestEntry.outcome === "struggle") {
      outcomeText = "Stress";
      outcomeClass = "struggle";
    } else if (latestEntry.outcome === "aborted") {
      outcomeText = "Aborted";
      outcomeClass = "aborted";
    } else if (warmups.length > 0) {
      outcomeText = "Aborted";
      outcomeClass = "aborted";
    }
    if (outcomeCell) {
      outcomeCell.textContent = outcomeText;
      outcomeCell.className = `outcome ${outcomeClass}`;
    }

    const notesText =
      longTargetEntry?.notes ||
      (warmups.length > 0 ? "Session ended before long target." : latestEntry.notes);
    setCellText(row, ".notes", notesText);
    const actionsCell = row.querySelector(".actions");
    if (actionsCell) {
      actionsCell.classList.add("history-actions");
      const deleteBtn = document.createElement("button");
      deleteBtn.type = "button";
      deleteBtn.className = "btn ghost small";
      deleteBtn.textContent = "Delete";
      deleteBtn.addEventListener("click", () => deleteSessionGroup(group));
      actionsCell.appendChild(deleteBtn);

      if (canEditCompletedLongEntry(longTargetEntry)) {
        const editBtn = document.createElement("button");
        editBtn.type = "button";
        editBtn.className = "btn ghost small";
        editBtn.textContent = "Edit";
        editBtn.addEventListener("click", () => editCompletedLongRun(longTargetEntry));
        actionsCell.appendChild(editBtn);
      }
    }

    const warmupToggleBtn = row.querySelector(".warmup-toggle");
    const warmupRow = row.querySelector(".history-warmups-row");
    const warmupList = row.querySelector(".warmup-list");

    if (!warmupToggleBtn || !warmupRow || !warmupList) {
      historyBody.appendChild(row);
      return;
    }

    if (warmups.length === 0) {
      warmupToggleBtn.textContent = "No warmups";
      warmupToggleBtn.disabled = true;
    } else {
      warmupToggleBtn.textContent = `Warmups (${warmups.length})`;
      warmups.forEach((warmupEntry) => {
        const warmupOutcome =
          warmupEntry.outcome === "success"
            ? "Calm"
            : warmupEntry.outcome === "aborted"
            ? "Aborted"
            : "Stress";
        const warmupIndex = parseWarmupIndex(warmupEntry.phase) || 0;
        const item = document.createElement("li");
        const itemText = document.createElement("span");
        itemText.textContent = `Warmup ${warmupIndex}: ${formatSeconds(warmupEntry.actual)} / ${formatSeconds(
          warmupEntry.target
        )} (${warmupOutcome})`;
        item.appendChild(itemText);

        warmupList.appendChild(item);
      });

      warmupToggleBtn.addEventListener("click", () => {
        const isExpanded = warmupToggleBtn.getAttribute("aria-expanded") === "true";
        warmupToggleBtn.setAttribute("aria-expanded", isExpanded ? "false" : "true");
        warmupToggleBtn.textContent = isExpanded
          ? `Warmups (${warmups.length})`
          : "Hide warmups";
        warmupRow.hidden = isExpanded;
      });
    }

    historyBody.appendChild(row);
  });
}

function renderCalmTrend() {
  if (!calmTrendEl || !calmTrendChartEl) return;

  const points = getCalmTargetSeries();
  if (points.length < 2) {
    calmTrendEl.hidden = true;
    if (calmTrendChart) {
      calmTrendChart.destroy();
      calmTrendChart = null;
    }
    return;
  }

  calmTrendEl.hidden = false;
  const labels = points.map((point) =>
    new Date(point.date).toLocaleDateString(undefined, { month: "short", year: "numeric" })
  );
  const dataset = points.map((point) => point.target);
  const fullDates = points.map((point) =>
    new Date(point.date).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
  );
  const ctx = calmTrendChartEl.getContext("2d");
  if (!ctx) return;

  if (calmTrendChart) {
    calmTrendChart.data.labels = labels;
    calmTrendChart.data.datasets[0].data = dataset;
    calmTrendChart.data.datasets[0].fullDates = fullDates;
    calmTrendChart.update();
    return;
  }

  calmTrendChart = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "Successful calm target",
          data: dataset,
          fullDates,
          tension: 0.28,
          borderColor: "#a85f28",
          backgroundColor: "#a85f28",
          pointRadius: 3.5,
          pointHoverRadius: 5,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      aspectRatio: 640 / 220,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title(items) {
              if (!items.length) return "";
              const item = items[0];
              return item.dataset.fullDates?.[item.dataIndex] || "";
            },
            label(context) {
              return `Target: ${formatSeconds(Number(context.parsed.y))}`;
            },
          },
        },
      },
      scales: {
        x: {
          type: "category",
          ticks: { color: "#6f7d87" },
          grid: { color: "#e3d7c7" },
        },
        y: {
          beginAtZero: true,
          ticks: {
            color: "#6f7d87",
            callback(value) {
              return formatSeconds(Number(value));
            },
          },
          grid: { color: "#e3d7c7" },
        },
      },
    },
  });
}

function buildSessionGroups(history) {
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

function setCellText(root, selector, text) {
  const el = root.querySelector(selector);
  if (el) el.textContent = text;
}

function canEditCompletedLongEntry(entry) {
  return (
    !!entry &&
    isLongTargetPhase(entry.phase) &&
    (entry.outcome === "success" || entry.outcome === "struggle") &&
    Number.isFinite(entry.target) &&
    Number.isFinite(entry.actual)
  );
}

function deleteSessionGroup(group) {
  if (!group || !Number.isFinite(group.startIndex) || !Number.isFinite(group.count) || group.count < 1) return;
  const label = group.entries[0]?.date
    ? new Date(group.entries[0].date).toLocaleString()
    : "this session";
  const shouldDelete = window.confirm(`Delete session from ${label}?`);
  if (!shouldDelete) return;

  state.history.splice(group.startIndex, group.count);
  recalculateLongSuccessStreak();
  queueSaveState();
  renderHistory();
  renderStreak();
  setStatus("Session deleted from history.");
}

function editCompletedLongRun(entry) {
  if (!canEditCompletedLongEntry(entry)) return;

  const promptValue = window.prompt(
    "Set new actual duration (seconds):",
    String(clampInt(entry.actual, 0, 7200))
  );
  if (promptValue === null) return;

  const parsed = Number.parseInt(promptValue, 10);
  if (!Number.isFinite(parsed)) {
    setStatus("Invalid duration. Enter a whole number of seconds.");
    return;
  }

  const updatedActual = clampInt(parsed, 0, 7200);
  const currentOutcomeLabel = entry.outcome === "success" ? "calm" : "stress";
  const outcomeInput = window.prompt(
    "Set outcome (`calm` or `stress`):",
    currentOutcomeLabel
  );
  if (outcomeInput === null) return;

  const updatedOutcome = parseOutcomeInput(outcomeInput);
  if (!updatedOutcome) {
    setStatus("Invalid outcome. Use `calm` or `stress`.");
    return;
  }

  entry.actual = updatedActual;
  entry.outcome = updatedOutcome;
  entry.notes =
    updatedOutcome === "success"
      ? "Calm throughout planned duration."
      : "Stress signs near/after planned duration.";

  recalculateLongSuccessStreak();
  queueSaveState();
  renderHistory();
  renderStreak();
  setStatus(
    `Long run updated: ${formatSeconds(updatedActual)} (${updatedOutcome === "success" ? "Calm" : "Stress"}).`
  );
}

function parseOutcomeInput(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (normalized === "calm" || normalized === "success") return "success";
  if (normalized === "stress" || normalized === "struggle") return "struggle";
  return null;
}

function recalculateLongSuccessStreak() {
  let streak = 0;
  for (const entry of state.history) {
    if (!isLongTargetPhase(entry.phase)) continue;
    if (entry.outcome === "success") {
      streak += 1;
      continue;
    }
    break;
  }
  state.longSuccessStreak = streak;
}

function pickNewerState(cloudState, localState) {
  if (!localState) return cloudState;
  const cloudUpdatedAt = Number.isFinite(cloudState?.updatedAt) ? cloudState.updatedAt : 0;
  const localUpdatedAt = Number.isFinite(localState?.updatedAt) ? localState.updatedAt : 0;
  return localUpdatedAt > cloudUpdatedAt ? localState : cloudState;
}

function localBackupKey(uid) {
  return `${LOCAL_STATE_KEY_PREFIX}:${uid || "anon"}`;
}

function persistLocalBackupState(uid, payload) {
  try {
    window.localStorage.setItem(localBackupKey(uid), JSON.stringify(payload));
  } catch (error) {
    console.error(error);
  }
}

function loadLocalBackupState(uid) {
  try {
    const raw = window.localStorage.getItem(localBackupKey(uid));
    if (!raw) return null;
    return sanitizeState(JSON.parse(raw));
  } catch (error) {
    console.error(error);
    return null;
  }
}

function getCalmTargetSeries() {
  return state.history
    .filter((entry) => isLongTargetPhase(entry.phase) && entry.outcome === "success")
    .map((entry) => ({
      date: entry.date,
      target: clampInt(entry.target, 1, 7200),
    }))
    .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
}

function getLongestCalmTarget() {
  const calmSeries = getCalmTargetSeries();
  if (calmSeries.length === 0) return null;
  return calmSeries.reduce((max, entry) => Math.max(max, entry.target), 0);
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

function sanitizeHistoryEntry(entry) {
  if (!entry || typeof entry !== "object") return null;

  const date =
    typeof entry.date === "string" && !Number.isNaN(new Date(entry.date).getTime())
      ? entry.date
      : new Date().toISOString();
  const day =
    typeof entry.day === "string" && entry.day.trim() ? entry.day : isoDayFromDate(date) || todayKey();
  const phase = typeof entry.phase === "string" && entry.phase.trim() ? entry.phase : "Long target";
  const notes = typeof entry.notes === "string" ? entry.notes : "";
  const outcome =
    entry.outcome === "success" || entry.outcome === "aborted" ? entry.outcome : "struggle";
  const sessionId =
    typeof entry.sessionId === "string" && entry.sessionId.trim() ? entry.sessionId.trim() : undefined;

  return {
    date,
    day,
    sessionId,
    phase,
    target: clampInt(entry.target, 1, 7200),
    actual: clampInt(entry.actual, 0, 7200),
    outcome,
    notes,
  };
}

function describeError(error) {
  if (error == null) return "no error details";
  if (typeof error === "string") return error;

  const code = typeof error.code === "string" && error.code.trim() ? error.code.trim() : "";
  const message = typeof error.message === "string" && error.message.trim() ? error.message.trim() : "";
  const name = typeof error.name === "string" && error.name.trim() ? error.name.trim() : "";
  const asString = String(error);
  const hasUsefulString = asString && asString !== "[object Object]";

  if (code && message) return `${code}: ${message}`;
  if (code) return code;
  if (message) return message;
  if (name && hasUsefulString) return `${name}: ${asString}`;
  if (name) return name;
  if (hasUsefulString) return asString;

  try {
    const compact = JSON.stringify(error);
    if (compact && compact !== "{}") return compact;
  } catch (jsonError) {
    console.error(jsonError);
  }

  return `unclassified ${typeof error} error`;
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
  if (value === "reduce" || value === "retry" || value === "last-success") return value;
  return "reduce";
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

  if (mode === "last-success") {
    const lastSuccessfulTarget = getLastSuccessfulLongTarget();
    if (lastSuccessfulTarget !== null) {
      state.nextLongTarget = lastSuccessfulTarget;
      setStatus(
        `Long target struggled. Next long target set to last successful duration (${formatSeconds(
          state.nextLongTarget
        )}).`
      );
      return;
    }

    state.nextLongTarget = currentTarget;
    setStatus("Long target struggled. No previous success found, so the same target will be retried.");
    return;
  }
}

function getLastSuccessfulLongTarget() {
  for (const entry of state.history) {
    if (isLongTargetPhase(entry.phase) && entry.outcome === "success") {
      return clampInt(entry.target, 3, 7200);
    }
  }
  return null;
}

function isFirebaseConfigValid(config) {
  const required = ["apiKey", "authDomain", "projectId", "appId"];
  return !!config && required.every((key) => typeof config[key] === "string" && config[key].trim());
}
