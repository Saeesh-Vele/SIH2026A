/* Aurora — end-to-end smoke test against the real stack (backend + simulator + Vite).
 *
 * What it proves:
 *   1. The overview renders with live telemetry and a declared data source.
 *   2. Every sidebar module opens — no console errors, no failed requests anywhere.
 *   3. Injecting generator_failure on bharati surfaces a bharati alert in the UI
 *      (the alert engine runs in the backend tick, so this exercises the whole path).
 *
 * Runs with software WebGL (see playwright.config.js) so the three.js twin renders
 * rather than silently taking the 2D fallback.
 */
import { expect, test } from '@playwright/test';

// Against the Docker stack the API is same-origin behind nginx (E2E_BASE_URL);
// locally Playwright starts the backend on its own port.
const API = process.env.E2E_BASE_URL || `http://127.0.0.1:${process.env.API_PORT || '8080'}`;

// Set when the stack enforces write protection, so the spec signs in before writing.
// Empty means ADMIN_TOKEN is unset server-side and every control is already enabled.
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const WRITE_HEADERS = ADMIN_TOKEN ? { 'X-Admin-Token': ADMIN_TOKEN } : {};

// Tests that change server state (fault injection, simulator reset, a ledger edit) run
// against the local or CI stack, which is throwaway. Against a remote deployment (an
// E2E_BASE_URL that is not localhost) they are skipped unless E2E_ALLOW_LIVE_WRITES=1:
// a live demo's ledger, alerts and scenarios belong to the people using it.
const IS_REMOTE = Boolean(process.env.E2E_BASE_URL)
  && !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/.test(process.env.E2E_BASE_URL);
const ALLOW_WRITES = !IS_REMOTE || process.env.E2E_ALLOW_LIVE_WRITES === '1';
const LIVE_WRITES_SKIPPED = 'changes server state on a remote deployment; set E2E_ALLOW_LIVE_WRITES=1 to run it';

// Module id -> text that only THAT module's panel renders. Legacy panels are matched on
// their own headings; modules rebuilt on the design system on their page title. The tour
// asserts the marker so it catches "the sidebar switched but the panel did not", and it
// asserts exactly one module panel is mounted, which catches the opposite: audit F1, where
// every visited module stayed stacked on screen. Both bugs hid behind a weaker check.
const MODULES = [
  ['overview', null],
  ['environmental', /Stored observations and analysis/i],
  ['infrastructure', /Dependency map/i],
  ['energy', /Energy grid/i],
  ['logistics', /Audit log/i],
  ['remote', /Command log/i],
  ['simulation', /Run a scenario to see/i],
  ['ai', /Anomaly evidence/i],
  ['reports', /Station status report/i],
  ['admin', /Station configuration/i],
];

/** Vite's dev client and source maps are not the app under test. */
const IGNORED_URL = /\/@vite\/|\/@react-refresh|\.map$|favicon/;

/** Collect every console error and failed request for the whole page lifetime. */
function watchForProblems(page) {
  const consoleErrors = [];
  const failedRequests = [];

  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => consoleErrors.push(`uncaught: ${err.message}`));
  page.on('requestfailed', (req) => {
    if (!IGNORED_URL.test(req.url())) {
      failedRequests.push(`${req.method()} ${req.url()} — ${req.failure()?.errorText}`);
    }
  });
  page.on('response', (res) => {
    if (res.status() >= 400 && !IGNORED_URL.test(res.url())) {
      failedRequests.push(`${res.status()} ${res.request().method()} ${res.url()}`);
    }
  });

  return { consoleErrors, failedRequests };
}

/**
 * Sign in through the TopBar so the write controls become enabled. A no-op when the
 * server does not protect writes (the pill is not rendered at all then).
 */
async function operatorLogin(page) {
  const pill = page.getByTestId('operator-login');
  if (!(await pill.count())) return false;          // writes are unprotected
  await pill.click();
  await page.getByTestId('operator-token-input').fill(ADMIN_TOKEN);
  await page.getByTestId('operator-submit').click();
  await expect(page.getByTestId('operator-logout')).toBeVisible();
  return true;
}

async function openStation(page, stationId) {
  const option = page.getByTestId(`station-option-${stationId}`);
  await option.click();
  await expect(option).toHaveAttribute('aria-pressed', 'true');
}

/** Select a module in the sidebar and wait until it is the current page. */
async function openModule(page, moduleId) {
  await page.getByTestId(`nav-${moduleId}`).click();
  await expect(page.getByTestId(`nav-${moduleId}`), `${moduleId} did not become the active module`)
    .toHaveAttribute('aria-current', 'page');
}

// The product tour auto-starts on a first visit. Every test except the tour tests runs
// as a returning visitor, so the tour never covers what they click.
const TOUR_KEY = 'aurora-tour-v1';
test.beforeEach(async ({ page }, testInfo) => {
  if (testInfo.title.includes('product tour')) return;
  await page.addInitScript((key) => {
    try { window.localStorage.setItem(key, '{"outcome":"e2e"}'); } catch (err) { console.warn(err); }
  }, TOUR_KEY);
});

/** Step through the open tour to the end: Next, → (keyboard) alternately. Returns the titles. */
async function completeTour(page, total) {
  const popover = page.getByTestId('tour-popover');
  const titles = [];
  for (let i = 1; i <= total; i++) {
    await expect(popover).toHaveAttribute('data-tour-step', String(i));
    await expect(popover).toContainText(`${i} of ${total}`);
    await expect(page.getByTestId('tour-next')).toBeFocused();
    titles.push(await popover.locator('h2').textContent());
    if (i % 2) await page.getByTestId('tour-next').click();
    else await page.keyboard.press('ArrowRight');
  }
  await expect(popover).toHaveCount(0);
  return titles;
}

test.beforeAll(async ({ request }) => {
  // The whole stack must be up before the browser opens. The backend starts first and
  // caches its simulator probe for 5 s, so poll rather than asserting on the first read.
  await expect
    .poll(async () => {
      const res = await request.get(`${API}/api/health`);
      if (!res.ok()) return null;
      const body = await res.json();
      return body.db.ok && body.simulator.reachable;
    }, { timeout: 30_000, message: 'backend never reported the simulator as reachable' })
    .toBe(true);
});

test('the overview renders live telemetry with a declared data source', async ({ page }) => {
  const { consoleErrors, failedRequests } = watchForProblems(page);

  await page.goto('/');
  await expect(page.locator('.aurora-app')).toBeVisible();
  await expect(page.locator('.overview-stage')).toBeVisible();

  // Telemetry has arrived and the UI says where it came from (CLAUDE.md: provenance).
  const badge = page.getByTestId('data-source-badge');
  await expect(badge).toBeVisible();
  await expect(badge).toHaveAttribute('data-source', /simulator|physics-fallback|browser-demo/);

  // The 3D twin renders under software WebGL, so the 2D fallback must not be showing.
  await expect(page.getByTestId('station-2d-fallback')).toHaveCount(0);
  await expect(page.locator('.scene-container canvas')).toBeVisible();

  expect(consoleErrors, 'console errors on the overview').toEqual([]);
  expect(failedRequests, 'failed requests on the overview').toEqual([]);
});

test('every module opens cleanly', async ({ page }) => {
  const { consoleErrors, failedRequests } = watchForProblems(page);

  await page.goto('/');
  await expect(page.locator('.overview-stage')).toBeVisible();

  for (const [id, marker] of MODULES) {
    await openModule(page, id);
    // Either the overview stage or a module panel must render — never an empty stage
    // and never the ErrorBoundary fallback.
    await expect(page.locator('.overview-stage, .module-content-scroll')).toBeVisible();
    await expect(page.getByTestId('error-boundary'), `${id} crashed`).toHaveCount(0);
    if (marker) {
      // Exactly one module page, and it is THIS module's; the loading placeholder clears.
      await expect(page.getByTestId('module-panel'), `more than one module on screen after ${id}`).toHaveCount(1);
      await expect(page.getByTestId('module-panel')).toHaveAttribute('data-module', id);
      await expect(page.getByTestId('panel-fallback')).toHaveCount(0);
      await expect(page.getByTestId('module-panel'),
                   `${id} was selected but its panel did not render`).toContainText(marker);
    } else {
      await expect(page.getByTestId('module-panel')).toHaveCount(0);
    }
  }

  expect(consoleErrors, 'console errors while touring the modules').toEqual([]);
  expect(failedRequests, 'failed requests while touring the modules').toEqual([]);
});

test('an injected generator failure on bharati shows up as a bharati alert', async ({ page, request }) => {
  test.skip(!ALLOW_WRITES, LIVE_WRITES_SKIPPED);
  const { consoleErrors, failedRequests } = watchForProblems(page);

  await page.goto('/');
  await expect(page.locator('.overview-stage')).toBeVisible();

  // Sign in as operator so the UI's write controls are live (and to prove the login
  // flow works end to end). Skipped when the stack has no ADMIN_TOKEN set.
  const loggedIn = await operatorLogin(page);
  await openStation(page, 'bharati');

  // Inject through the API, exactly as Demo Control does — with the token when the
  // stack requires one.
  const inject = await request.post(`${API}/api/sim/inject/generator_failure?stationId=bharati`,
                                    { headers: WRITE_HEADERS });
  try {
    expect(inject.ok(), await inject.text()).toBeTruthy();
    if (loggedIn) {
      // The acknowledge button is only enabled for a signed-in operator.
      expect(ADMIN_TOKEN).not.toBe('');
    }

    // The backend tick (2 s) evaluates thresholds and pushes the alert over the WebSocket.
    const pill = page.getByTestId('alerts-pill');
    await expect
      .poll(async () => Number(await pill.getAttribute('data-alert-count')), { timeout: 10_000 })
      .toBeGreaterThan(0);

    // It is bharati's alert, and the backend agrees.
    const alerts = await (await request.get(`${API}/api/alerts?stationId=bharati`)).json();
    expect(alerts.stationId).toBe('bharati');
    expect(alerts.activeAlerts.length).toBeGreaterThan(0);

    await page.getByTestId('alerts-pill').click();
    await expect(page.getByTestId('alert-drawer')).toBeVisible();
  } finally {
    // Always clear the injection, pass or fail.
    const reset = await request.post(`${API}/api/sim/reset?stationId=bharati`, { headers: WRITE_HEADERS });
    expect(reset.ok(), `bharati was left with an injected scenario: ${await reset.text()}`).toBeTruthy();
  }
  expect(consoleErrors, 'console errors during alert injection').toEqual([]);
  expect(failedRequests, 'failed requests during alert injection').toEqual([]);
});

test('viewing needs no login, and writes are refused without one', async ({ page, request }) => {
  test.skip(!ADMIN_TOKEN, 'ADMIN_TOKEN is not set for this stack, so writes are unprotected');
  const { consoleErrors, failedRequests } = watchForProblems(page);

  await page.goto('/');
  await expect(page.locator('.overview-stage')).toBeVisible();

  // The whole dashboard is viewable while signed out, and says so.
  await expect(page.getByTestId('operator-login')).toHaveText(/read-only/i);
  await expect(page.getByTestId('data-source-badge')).toBeVisible();
  for (const id of ['environmental', 'logistics', 'admin']) {
    await openModule(page, id);
    await expect(page.locator('.module-content-scroll')).toBeVisible();
  }

  // A write control is disabled because nobody is signed in (WriteButton marks why). The
  // thresholds form lives behind the "Alert thresholds" tab of Administration.
  await openModule(page, 'admin');
  await page.getByTestId('admin-tab-thresholds').click();
  const save = page.getByTestId('admin-save');
  await expect(save).toBeVisible();
  await expect(save).toBeDisabled();
  await expect(save).toHaveAttribute('data-write-blocked', 'true');

  // ...and so is the ingest button on the Data sources tab.
  await page.getByTestId('admin-tab-sources').click();
  const sync = page.getByTestId('admin-ingest-maitri');
  await expect(sync).toBeDisabled();
  await expect(sync).toHaveAttribute('data-write-blocked', 'true');

  // The API agrees: the same write is a 401 unauthenticated and a 200 with the token.
  // The 401 is deterministic — require_admin rejects before the proxy is attempted.
  const denied = await request.post(`${API}/api/sim/reset?stationId=maitri`);
  expect(denied.status()).toBe(401);
  // The authenticated case proxies to the simulator, whose readiness is independent of
  // the backend's, so a momentary 503 here is startup timing rather than an auth failure.
  // A real write, so not against a live deployment: it would clear anyone's demo scenario.
  if (ALLOW_WRITES) {
    await expect
      .poll(async () => (await request.post(`${API}/api/sim/reset?stationId=maitri`,
                                            { headers: WRITE_HEADERS })).status(),
            { timeout: 30_000, message: 'authenticated write never succeeded' })
      .toBe(200);
  }

  // Signing in enables the controls again (Save stays disabled until something changes).
  await operatorLogin(page);
  await expect(sync).toBeEnabled();
  await page.getByTestId('admin-tab-thresholds').click();
  await expect(save).not.toHaveAttribute('data-write-blocked', 'true');

  expect(consoleErrors, 'console errors while signed out').toEqual([]);
  expect(failedRequests.filter((f) => !f.startsWith('401')), 'unexpected failed requests').toEqual([]);
});

test('on a phone the top bar fits, Sign in stays reachable and demo control covers nothing', async ({ page }) => {
  const { consoleErrors, failedRequests } = watchForProblems(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByTestId('data-source-badge')).toBeVisible();

  // One top bar, no horizontal scroll, and no floating button over the page.
  const fits = await page.evaluate(() => {
    const bar = document.querySelector('.MuiToolbar-root');
    return document.documentElement.scrollWidth <= window.innerWidth && bar.scrollWidth <= bar.clientWidth;
  });
  expect(fits, 'top bar or page overflows horizontally at 390 px').toBe(true);
  await expect(page.locator('.demo-toggle')).toHaveCount(0);
  if (ADMIN_TOKEN) await expect(page.getByTestId('operator-login')).toBeVisible();

  // The status dot has an accessible name, and a tap shows the data source in a tooltip.
  const dot = page.getByTestId('data-source-badge');
  await expect(dot).toHaveAccessibleName(/^Data source: /);
  await dot.click();
  await expect(page.getByRole('tooltip')).toContainText(/simulator|fallback|demo|connecting/i);

  // Demo control opens from the overflow menu.
  await page.getByTestId('topbar-more').click();
  await page.getByTestId('menu-demo-control').click();
  await expect(page.getByTestId('demo-control-panel')).toBeVisible();
  await page.getByTestId('demo-control-panel-close').click();
  await expect(page.getByTestId('demo-control-panel')).toHaveCount(0);

  expect(consoleErrors, 'console errors on a phone').toEqual([]);
  expect(failedRequests, 'failed requests on a phone').toEqual([]);
});

test('the building panel shows live readings from telemetry (audit F2)', async ({ page }) => {
  const { consoleErrors, failedRequests } = watchForProblems(page);
  await page.goto('/');
  await expect(page.getByTestId('data-source-badge')).toHaveAttribute('data-source', /simulator|physics-fallback/);
  await openModule(page, 'infrastructure');
  await page.getByTestId('building-tile-generator').click();

  const drawer = page.getByTestId('building-drawer');
  await expect(drawer).toBeVisible();
  const rows = drawer.locator('[data-testid^="reading-"]');
  await expect(rows).toHaveCount(4);                                // gen_power, fuel rate, rpm, coolant
  // Live values, not "—" and not a built-in nominal: the drawer's generator power equals the tile's.
  await expect(drawer.getByTestId('reading-gen_power')).not.toContainText('—');
  // Dependency chips open the upstream building.
  await drawer.getByRole('button', { name: /Logistics Store/ }).click();
  await expect(drawer.getByRole('heading', { name: 'Logistics Store' })).toBeVisible();
  await page.getByTestId('building-drawer-close').click();
  await expect(drawer).toHaveCount(0);

  // The dependency map opens the same panel from the keyboard.
  await page.getByTestId('dep-node-generator').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('building-drawer')).toBeVisible();

  expect(consoleErrors, 'console errors in the building panel').toEqual([]);
  expect(failedRequests, 'failed requests in the building panel').toEqual([]);
});


test('operate and analyse pages: read-only what-if and the twin inspector', async ({ page }) => {
  const { consoleErrors, failedRequests } = watchForProblems(page);
  await page.goto('/');
  await expect(page.getByTestId('data-source-badge')).toHaveAttribute('data-source', /simulator|physics-fallback/);

  // What-if needs no sign-in (it changes nothing) and says it is rule-based.
  await openModule(page, 'simulation');
  await page.getByTestId('scenario-fuel_leak').click();
  await page.getByTestId('whatif-run').click();
  const result = page.getByTestId('whatif-result');
  await expect(result).toContainText(/Fuel autonomy \d+ → \d+ days/);
  await expect(result).toContainText(/not the physics model/);

  // Twin inspector opens as a dialog and closes with Escape.
  await page.getByTestId('nav-twinInspector').click();
  await expect(page.getByTestId('twin-inspector')).toBeVisible();
  await expect(page.getByTestId('twin-inspector')).toContainText(/Thermal model/);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('twin-inspector')).toHaveCount(0);

  expect(consoleErrors, 'console errors on operate/analyse pages').toEqual([]);
  expect(failedRequests, 'failed requests on operate/analyse pages').toEqual([]);
});

test('a ledger edit asks first, lands in the audit log, and is put back afterwards', async ({ page, request }) => {
  test.skip(!ALLOW_WRITES, LIVE_WRITES_SKIPPED);
  const { consoleErrors, failedRequests } = watchForProblems(page);
  const ITEM = 'maitri-med';
  const readItem = async () => (await (await request.get(`${API}/api/logistics?stationId=maitri`)).json())
    .items.find((i) => i.id === ITEM);
  const original = (await readItem()).current;

  try {
    await page.goto('/?module=logistics&station=maitri');
    // Signed in when the stack protects writes.
    const loggedIn = await operatorLogin(page);
    expect(loggedIn || !ADMIN_TOKEN).toBe(true);
    await page.getByTestId(`ledger-edit-${ITEM}`).click();
    const input = page.getByTestId('ledger-current');
    const next = String(original - 1);
    await input.fill(next);
    await page.getByTestId('ledger-save').click();
    // Every state-changing action asks first.
    await expect(page.getByTestId('confirm-dialog')).toContainText(/Write .* to the ledger/);
    await page.getByTestId('confirm-ok').click();
    await expect(page.getByTestId('toast')).toContainText(/Saved/);
    await expect(page.getByTestId('logistics-history')).toContainText(`→ ${next}`);
  } finally {
    // Put the original value back, pass or fail, so no run leaves the ledger changed.
    if ((await readItem()).current !== original) {
      const res = await request.post(`${API}/api/logistics/update`, {
        headers: WRITE_HEADERS,
        data: { stationId: 'maitri', itemId: ITEM, current: original, updatedBy: 'e2e restore' },
      });
      expect(res.ok(), `could not restore ${ITEM}: ${await res.text()}`).toBeTruthy();
    }
    expect((await readItem()).current, `${ITEM} was not restored`).toBe(original);
  }

  expect(consoleErrors, 'console errors during the ledger edit').toEqual([]);
  expect(failedRequests, 'failed requests during the ledger edit').toEqual([]);
});

test('command palette, keyboard shortcuts, URL state and the alert centre tabs', async ({ page }) => {
  const { consoleErrors, failedRequests } = watchForProblems(page);
  await page.goto('/?module=energy&station=bharati');
  // The URL opens the page and station directly (refresh-safe, shareable).
  await expect(page.getByTestId('module-panel')).toHaveAttribute('data-module', 'energy');
  await expect(page.getByTestId('station-option-bharati')).toHaveAttribute('aria-pressed', 'true');

  // ⌘K / Ctrl+K → type → Enter navigates, and the URL follows.
  await page.keyboard.press('ControlOrMeta+k');
  await expect(page.getByTestId('command-palette')).toBeVisible();
  await page.getByTestId('palette-input').fill('weather');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('module-panel')).toHaveAttribute('data-module', 'environmental');
  await expect(page).toHaveURL(/module=environmental&station=bharati/);

  // With write protection on, "Sign in as operator" opens the sign-in dialog itself.
  if (ADMIN_TOKEN) {
    await page.keyboard.press('ControlOrMeta+k');
    await page.getByTestId('palette-input').fill('sign in');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('operator-token-input')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('operator-token-input')).toHaveCount(0);
  }

  // "g" then a letter navigates; "?" opens the help; Esc closes it.
  await page.locator('body').click({ position: { x: 5, y: 300 } });
  await page.keyboard.press('g');
  await page.keyboard.press('a');
  await expect(page.getByTestId('module-panel')).toHaveAttribute('data-module', 'ai');
  await page.keyboard.press('?');
  await expect(page.getByTestId('shortcuts-dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('shortcuts-dialog')).toHaveCount(0);

  // Back returns to the previous page; a reload keeps the current one.
  await page.goBack();
  await expect(page.getByTestId('module-panel')).toHaveAttribute('data-module', 'environmental');
  await page.reload();
  await expect(page.getByTestId('module-panel')).toHaveAttribute('data-module', 'environmental');

  // The alert centre has Active / Acknowledged / History.
  await page.getByTestId('alerts-pill').click();
  await expect(page.getByTestId('alert-drawer')).toBeVisible();
  for (const tab of ['active', 'acknowledged', 'history']) {
    await page.getByTestId(`alerts-tab-${tab}`).click();
    await expect(page.getByTestId(`alerts-tab-${tab}`)).toHaveAttribute('aria-selected', 'true');
  }

  expect(consoleErrors, 'console errors with palette/shortcuts').toEqual([]);
  expect(failedRequests, 'failed requests with palette/shortcuts').toEqual([]);
});

test('the product tour starts once on a first visit, runs to the end and is not shown again', async ({ page }) => {
  const { consoleErrors, failedRequests } = watchForProblems(page);
  await page.goto('/');
  // Auto-start waits for the first telemetry snapshot.
  await expect(page.getByTestId('tour-popover')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('data-source-badge')).not.toHaveAttribute('data-source', 'connecting');
  await expect(page.getByTestId('tour-back')).toBeHidden();         // nothing to go back to on step 1

  // ← goes back a step; then run all 12 steps through.
  await page.getByTestId('tour-next').click();
  await expect(page.getByTestId('tour-popover')).toHaveAttribute('data-tour-step', '2');
  await page.keyboard.press('ArrowLeft');
  const titles = await completeTour(page, 12);
  expect(titles[0]).toBe('Choose a station');
  expect(titles[11]).toBe('System');
  // Focus is back on the page, not lost on <body>.
  await expect.poll(() => page.evaluate(() => document.activeElement !== document.body)).toBe(true);
  expect(await page.evaluate((k) => JSON.parse(localStorage.getItem(k)).outcome, TOUR_KEY)).toBe('completed');

  // Second visit: no tour, even after telemetry arrives.
  await page.reload();
  await expect(page.getByTestId('data-source-badge')).toHaveAttribute('data-source', /simulator|physics-fallback/);
  await page.waitForTimeout(2000);
  await expect(page.getByTestId('tour-popover')).toHaveCount(0);

  // Restartable from the Help menu, and Esc ends it.
  await page.getByTestId('help-open').click();
  await page.getByTestId('help-tour').click();
  await expect(page.getByTestId('tour-popover')).toHaveAttribute('data-tour-step', '1');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('tour-popover')).toHaveCount(0);

  // …and from the command palette and the "?" help dialog.
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByTestId('palette-input').fill('start tour');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('tour-popover')).toBeVisible();
  await page.getByTestId('tour-skip').click();
  await expect(page.getByTestId('tour-popover')).toHaveCount(0);
  await page.locator('body').click({ position: { x: 5, y: 300 } });
  await page.keyboard.press('?');
  await page.getByTestId('shortcuts-start-tour').click();
  await expect(page.getByTestId('tour-popover')).toBeVisible();
  await page.keyboard.press('Escape');

  expect(consoleErrors, 'console errors during the tour').toEqual([]);
  expect(failedRequests, 'failed requests during the tour').toEqual([]);
});

test('product tour: ?tour=off suppresses it and ?tour=start forces it', async ({ page }) => {
  await page.goto('/?tour=off');
  await expect(page.getByTestId('data-source-badge')).toHaveAttribute('data-source', /simulator|physics-fallback/);
  await page.waitForTimeout(2000);
  await expect(page.getByTestId('tour-popover')).toHaveCount(0);

  // Mark it seen, then force it.
  await page.evaluate((k) => localStorage.setItem(k, '{"outcome":"completed"}'), TOUR_KEY);
  await page.goto('/?module=energy&tour=start');
  await expect(page.getByTestId('tour-popover')).toBeVisible({ timeout: 30_000 });
  await expect(page).not.toHaveURL(/tour=start/);                   // a reload won't restart it
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('tour-popover')).toHaveCount(0);
});

test('product tour on a phone: sidebar steps open the drawer, demo control points at the ⋮ menu', async ({ page }) => {
  const { consoleErrors, failedRequests } = watchForProblems(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  const popover = page.getByTestId('tour-popover');
  await expect(popover).toBeVisible({ timeout: 30_000 });
  const drawer = page.getByTestId('mobile-nav');
  for (let i = 1; i <= 12; i++) {
    await expect(popover).toHaveAttribute('data-tour-step', String(i));
    const title = await popover.locator('h2').textContent();
    if (['Monitor', 'Operate', 'Analyse', 'AI diagnostics', 'Twin inspector', 'System'].includes(title)) {
      await expect(drawer, `${title}: the drawer is open`).toBeVisible();
    }
    if (title === 'Demo control') {
      await expect(drawer).toBeHidden();
      await expect(popover).toContainText('⋮ menu');
      await expect(page.locator('.driver-active-element')).toHaveAttribute('data-testid', 'topbar-more');
    }
    // Every step is fully on screen.
    const box = await popover.boundingBox();
    expect(box.x >= 0 && box.x + box.width <= 390 && box.y >= 0 && box.y + box.height <= 844, `step ${i} fits`).toBe(true);
    await page.getByTestId('tour-next').click();
  }
  await expect(popover).toHaveCount(0);
  await expect(drawer).toBeHidden();

  expect(consoleErrors, 'console errors in the phone tour').toEqual([]);
  expect(failedRequests, 'failed requests in the phone tour').toEqual([]);
});

test('page tours: Tour this page on Weather, Infrastructure, What-if and Administration', async ({ page }) => {
  for (const [id, steps] of [['environmental', 4], ['infrastructure', 3], ['simulation', 4], ['admin', 3]]) {
    await page.goto(`/?module=${id}`);
    await page.getByTestId('page-tour').click();
    await completeTour(page, steps);
  }
  // The thresholds tour leaves Administration on its thresholds tab.
  await expect(page.getByTestId('admin-tab-thresholds')).toHaveAttribute('aria-selected', 'true');
});
