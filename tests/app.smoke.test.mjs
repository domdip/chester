import test from "node:test";
import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { startStaticServer } from "./support/static-server.mjs";

function getTodayKey() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

async function resolveChromiumExecutable(rootDir) {
  const bundledExecutable = path.join(
    rootDir,
    ".playwright-browsers",
    "chromium-1208",
    "chrome-linux64",
    "chrome"
  );

  try {
    await access(bundledExecutable);
    return bundledExecutable;
  } catch {
    return undefined;
  }
}

function buildFirebaseAppStub() {
  return `
    export function initializeApp(config) {
      return { config };
    }
  `;
}

function buildFirebaseAuthStub() {
  return `
    export function getAuth(app) {
      return { app };
    }
    export async function getRedirectResult() {
      return null;
    }
    export class GoogleAuthProvider {
      setCustomParameters() {}
    }
    export function onAuthStateChanged(auth, onNext) {
      setTimeout(() => onNext({ uid: "user123456", email: "tester@example.com" }), 0);
      return () => {};
    }
    export async function signInWithPopup() {}
    export async function signInWithRedirect() {}
    export async function signOut() {}
  `;
}

function buildFirestoreStub(cloudState) {
  return `
    const CLOUD_STATE = ${JSON.stringify(cloudState)};
    export function doc(...segments) {
      return { path: segments.join("/") };
    }
    export function getFirestore(app) {
      return { app };
    }
    export async function getDoc() {
      return {
        exists() {
          return true;
        },
        data() {
          return CLOUD_STATE;
        },
      };
    }
    export async function setDoc() {}
  `;
}

function buildChartStub() {
  return `
    export const registerables = [];
    export class Chart {
      static register() {}
      constructor(ctx, config) {
        this.ctx = ctx;
        this.data = config?.data || { labels: [], datasets: [{ data: [] }] };
      }
      destroy() {}
      update() {}
    }
  `;
}

async function stubExternalModules(page, cloudState) {
  await page.route("https://www.gstatic.com/firebasejs/**/firebase-app.js", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/javascript",
      body: buildFirebaseAppStub(),
    })
  );

  await page.route("https://www.gstatic.com/firebasejs/**/firebase-auth.js", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/javascript",
      body: buildFirebaseAuthStub(),
    })
  );

  await page.route("https://www.gstatic.com/firebasejs/**/firebase-firestore.js", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/javascript",
      body: buildFirestoreStub(cloudState),
    })
  );

  await page.route("https://cdn.jsdelivr.net/npm/chart.js@4.4.7/+esm", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/javascript",
      body: buildChartStub(),
    })
  );

  await page.route("https://fonts.googleapis.com/**", (route) => route.abort());
  await page.route("https://fonts.gstatic.com/**", (route) => route.abort());
}

test("app renders long-target emoji controls in sad-neutral-happy order with abort beneath", async () => {
  const server = await startStaticServer();
  const executablePath = await resolveChromiumExecutable(server.rootDir);
  const browser = await chromium.launch({
    executablePath,
    headless: true,
  });
  const page = await browser.newPage({ viewport: { width: 430, height: 932 } });

  const cloudState = {
    settings: {
      startDuration: 20,
      successIncreasePct: 20,
      failureMode: "reduce",
      failureReducePct: 10,
    },
    nextLongTarget: 720,
    dayPlan: {
      sessionId: "session-1",
      dateKey: getTodayKey(),
      targetDuration: 720,
      warmupCount: 2,
      sessions: [
        { kind: "warmup", duration: 45 },
        { kind: "warmup", duration: 30 },
        { kind: "long-target", duration: 720 },
      ],
      currentIndex: 2,
      targetOutcome: null,
    },
    history: [
      {
        date: new Date(Date.now() - 86400000).toISOString(),
        day: "2026-03-08",
        sessionId: "old-session",
        phase: "Long target",
        target: 600,
        actual: 600,
        outcome: "success",
        notes: "Calm throughout planned duration.",
      },
    ],
    longSuccessStreak: 1,
    updatedAt: Date.now(),
    ui: {
      setupCompleted: true,
      setupExpanded: false,
    },
  };

  try {
    await stubExternalModules(page, cloudState);
    await page.goto(`${server.url}/index.html`);

    await page.locator("#cloud-status").waitFor({ state: "visible" });
    await page.waitForFunction(() => {
      const cloudStatus = document.getElementById("cloud-status")?.textContent || "";
      return cloudStatus.includes("Cloud sync active");
    });

    await assert.doesNotReject(async () => {
      await page.locator("#session-type-label").waitFor();
    });

    assert.equal(await page.locator("#session-type-label").textContent(), "Long Target Session");
    assert.equal(await page.locator("#success-btn").textContent(), "😊");
    assert.equal(await page.locator("#middle-btn").textContent(), "😐");
    assert.equal(await page.locator("#struggle-btn").textContent(), "☹️");
    assert.equal(await page.locator("#success-btn").getAttribute("aria-label"), "Mark thumbs up");
    assert.equal(await page.locator("#middle-btn").getAttribute("aria-label"), "Mark middle");
    assert.equal(await page.locator("#struggle-btn").getAttribute("aria-label"), "Mark thumbs down");
    assert.equal(await page.locator("#start-btn").isEnabled(), true);
    assert.equal(await page.locator("#abort-controls").isVisible(), true);

    const sessionControlsBox = await page.locator("#session-controls").boundingBox();
    const resultActionsBox = await page.locator("#result-actions").boundingBox();
    const abortControlsBox = await page.locator("#abort-controls").boundingBox();
    const struggleBox = await page.locator("#struggle-btn").boundingBox();
    const middleBox = await page.locator("#middle-btn").boundingBox();
    const successBox = await page.locator("#success-btn").boundingBox();
    assert.ok(sessionControlsBox);
    assert.ok(resultActionsBox);
    assert.ok(abortControlsBox);
    assert.ok(struggleBox);
    assert.ok(middleBox);
    assert.ok(successBox);
    assert.ok(
      struggleBox.x < middleBox.x && middleBox.x < successBox.x,
      "long-target buttons should render in sad-neutral-happy order"
    );
    assert.ok(
      abortControlsBox.y > resultActionsBox.y + resultActionsBox.height - 1,
      "abort controls should render below the outcome row"
    );
    assert.ok(
      abortControlsBox.x <= resultActionsBox.x + 1,
      "abort row should be left-justified"
    );
  } finally {
    await page.close();
    await browser.close();
    await server.close();
  }
});

test("app restores a finished timer from newer local backup after reload-style recovery", async () => {
  const server = await startStaticServer();
  const executablePath = await resolveChromiumExecutable(server.rootDir);
  const browser = await chromium.launch({
    executablePath,
    headless: true,
  });
  const page = await browser.newPage({ viewport: { width: 430, height: 932 } });

  const baseState = {
    settings: {
      startDuration: 20,
      successIncreasePct: 20,
      failureMode: "reduce",
      failureReducePct: 10,
    },
    nextLongTarget: 90,
    dayPlan: {
      sessionId: "session-recover",
      dateKey: getTodayKey(),
      targetDuration: 90,
      warmupCount: 1,
      sessions: [
        { kind: "warmup", duration: 30 },
        { kind: "long-target", duration: 90 },
      ],
      currentIndex: 1,
      targetOutcome: null,
    },
    history: [],
    longSuccessStreak: 0,
    updatedAt: Date.now() - 60_000,
    ui: {
      setupCompleted: true,
      setupExpanded: false,
    },
  };

  const localRecoveredState = {
    ...baseState,
    updatedAt: Date.now(),
    activeTimer: {
      status: "running",
      sessionId: "session-recover",
      dayPlanDateKey: getTodayKey(),
      sessionIndex: 1,
      sessionKind: "long-target",
      targetDuration: 90,
      startedAt: Date.now() - 120_000,
      lastKnownElapsed: 12,
    },
  };

  try {
    await stubExternalModules(page, baseState);
    await page.addInitScript(({ key, value }) => {
      window.localStorage.setItem(key, JSON.stringify(value));
    }, {
      key: "separation-training-state-v1:user123456",
      value: localRecoveredState,
    });
    await page.goto(`${server.url}/index.html`);

    await page.waitForFunction(() => {
      const cloudStatus = document.getElementById("cloud-status")?.textContent || "";
      return cloudStatus.includes("Cloud sync active");
    });

    await page.waitForFunction(() => {
      const timer = document.getElementById("timer")?.textContent || "";
      const successBtn = document.getElementById("success-btn");
      return timer === "01:30" && successBtn instanceof HTMLButtonElement && successBtn.disabled === false;
    });

    assert.equal(await page.locator("#timer").textContent(), "01:30");
    assert.equal(await page.locator("#start-btn").isEnabled(), false);
    assert.equal(await page.locator("#stop-btn").isEnabled(), false);
    assert.equal(await page.locator("#success-btn").isEnabled(), true);
    assert.equal(await page.locator("#struggle-btn").isEnabled(), true);
    assert.equal(await page.locator("#middle-btn").isEnabled(), true);
  } finally {
    await page.close();
    await browser.close();
    await server.close();
  }
});
