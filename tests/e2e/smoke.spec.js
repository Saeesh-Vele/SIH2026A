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
import AxeBuilder from '@axe-core/playwright';
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
  const chip = page.getByTestId('sandbox-chip');
  await expect(pill.or(chip).or(page.getByTestId('data-source-badge')).first()).toBeVisible();
  if (await chip.count()) {
    // Judge mode: visitors are in a sandbox; the team signs in from the ⋮ menu.
    if (!ADMIN_TOKEN) return false;
    await page.getByTestId('topbar-more').click();
    await page.getByTestId('menu-team-signin').click();
  } else if (await pill.count()) {
    await pill.click();
  } else {
    return false;                                   // writes are unprotected
  }
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

// A first visit shows the welcome card (and ?tour=start the tour). Every test except the
// tour and welcome tests runs as a returning visitor, so neither covers what they click.
const TOUR_KEY = 'aurora-tour-v1';
const WELCOME_KEY = 'aurora-welcome-v1';
const returningVisitor = (keys) => {
  for (const key of keys) {
    try { window.localStorage.setItem(key, '{"outcome":"e2e"}'); } catch (err) { console.warn(err); }
  }
};
test.beforeEach(async ({ page }, testInfo) => {
  if (testInfo.title.includes('first visit')) return;
  await page.addInitScript(returningVisitor, [TOUR_KEY, WELCOME_KEY]);
});

/** Judge mode as the backend reports it: {sandbox, publicDemo, writeProtected}. */
async function judgeMode(request) {
  return (await request.get(`${API}/api/admin/session`)).json();
}

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
  await expect(page.getByTestId('scene-canvas')).toBeVisible();

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
  test.skip((await judgeMode(request)).sandbox, 'judge mode: covered by the sandbox tests below');
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
  const judge = await judgeMode(page.request);
  if (judge.sandbox) {
    // Judge mode: the Sandbox chip in the bar, Team sign-in in the ⋮ menu.
    await expect(page.getByTestId('sandbox-chip')).toBeVisible();
    await page.getByTestId('topbar-more').click();
    await expect(page.getByTestId('menu-team-signin')).toBeVisible();
    await page.keyboard.press('Escape');
  } else if (ADMIN_TOKEN) {
    await expect(page.getByTestId('operator-login')).toBeVisible();
  }

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

test('first visit: the welcome card shows once, and Take the tour runs the tour to the end', async ({ page }) => {
  const { consoleErrors, failedRequests } = watchForProblems(page);
  await page.goto('/');
  // The welcome card waits for the first telemetry snapshot; the tour starts from it.
  const welcome = page.getByTestId('welcome-card');
  await expect(welcome).toBeVisible({ timeout: 30_000 });
  await expect(welcome).toContainText('26060');
  await expect(welcome).toContainText('Real vs simulated');
  await page.getByTestId('welcome-tour').click();
  await expect(page.getByTestId('tour-popover')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('data-source-badge')).not.toHaveAttribute('data-source', 'connecting');
  await expect(page.getByTestId('tour-back')).toBeHidden();         // nothing to go back to on step 1

  // ← goes back a step; then run all 13 steps through.
  await page.getByTestId('tour-next').click();
  await expect(page.getByTestId('tour-popover')).toHaveAttribute('data-tour-step', '2');
  await page.keyboard.press('ArrowLeft');
  const titles = await completeTour(page, 13);
  expect(titles[0]).toBe('Choose a station');
  expect(titles[3]).toBe('Ask Aurora');
  expect(titles[12]).toBe('System');
  // Focus is back on the page, not lost on <body>.
  await expect.poll(() => page.evaluate(() => document.activeElement !== document.body)).toBe(true);
  expect(await page.evaluate((k) => JSON.parse(localStorage.getItem(k)).outcome, TOUR_KEY)).toBe('completed');

  // Second visit: no welcome card and no tour, even after telemetry arrives.
  await page.reload();
  await expect(page.getByTestId('data-source-badge')).toHaveAttribute('data-source', /simulator|physics-fallback/);
  await page.waitForTimeout(2000);
  await expect(page.getByTestId('tour-popover')).toHaveCount(0);
  await expect(page.getByTestId('welcome-card')).toHaveCount(0);
  // The welcome card reopens from Help.
  await page.getByTestId('help-open').click();
  await page.getByTestId('help-welcome').click();
  await expect(page.getByTestId('welcome-card')).toBeVisible();
  await page.getByTestId('welcome-explore').click();
  await expect(page.getByTestId('welcome-card')).toHaveCount(0);

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
  await page.goto('/?tour=start');
  const popover = page.getByTestId('tour-popover');
  await expect(popover).toBeVisible({ timeout: 30_000 });
  const drawer = page.getByTestId('mobile-nav');
  for (let i = 1; i <= 13; i++) {
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
  for (const [id, steps] of [['environmental', 5], ['infrastructure', 3], ['simulation', 4], ['admin', 3]]) {
    await page.goto(`/?module=${id}`);
    await page.getByTestId('page-tour').click();
    await completeTour(page, steps);
  }
  // The thresholds tour leaves Administration on its thresholds tab.
  await expect(page.getByTestId('admin-tab-thresholds')).toHaveAttribute('aria-selected', 'true');
});

test('3D overview: Buildings list opens the panel, stations switch by fly-over or pins, and the view is described', async ({ page }) => {
  const { consoleErrors, failedRequests } = watchForProblems(page);
  await page.goto('/?station=maitri');
  const scene = page.getByTestId('station-scene-3d');
  await expect(scene).toHaveAttribute('data-station', 'maitri');
  await expect(scene).toHaveAttribute('data-view', 'station');
  await expect(page.getByTestId('scene-schematic-note')).toHaveText('Schematic layout — positions approximate');
  await expect(page.getByTestId('scene-live-summary')).toContainText('Maitri station, schematic layout');

  // Every building is reachable without the canvas, with its level as text.
  await page.getByTestId('scene-buildings-button').click();
  const generator = page.getByTestId('scene-building-generator');
  await expect(generator).toContainText(/Normal|Warning|Critical/);
  await generator.click();
  await expect(page.getByTestId('building-drawer')).toBeVisible();
  await page.getByTestId('building-drawer-close').click();
  await expect(page.getByTestId('building-drawer')).toHaveCount(0);

  // Switching station from the top bar: a fly-over (or a crossfade on the low tier) lands on Bharati.
  await openStation(page, 'bharati');
  await expect(scene).toHaveAttribute('data-transition', /flyover|crossfade/);
  await expect(scene).not.toHaveAttribute('data-flying', 'true', { timeout: 15_000 });
  await expect(scene).toHaveAttribute('data-station', 'bharati');
  await expect(scene).toHaveAttribute('data-view', 'station');
  await page.getByTestId('scene-buildings-button').click();
  await expect(page.getByTestId('scene-building-storage')).toContainText('Kerosene tank farm');
  await page.keyboard.press('Escape');

  // The Antarctica view (button or A): both stations pinned; a pin switches station.
  await page.getByTestId('scene-view-antarctica').click();
  await expect(scene).toHaveAttribute('data-view', 'antarctica');
  const pin = page.getByRole('button', { name: 'Fly to Maitri' });
  await expect(pin).toBeVisible();
  await pin.click();
  await expect(page.getByTestId('station-option-maitri')).toHaveAttribute('aria-pressed', 'true');
  await expect(scene).not.toHaveAttribute('data-flying', 'true', { timeout: 15_000 });
  await expect(scene).toHaveAttribute('data-station', 'maitri');
  await expect(scene).toHaveAttribute('data-view', 'station');
  await page.keyboard.press('a');
  await expect(scene).toHaveAttribute('data-view', 'antarctica');
  await page.keyboard.press('a');
  await expect(scene).toHaveAttribute('data-view', 'station');

  expect(consoleErrors, 'console errors in the 3D overview').toEqual([]);
  expect(failedRequests, 'failed requests in the 3D overview').toEqual([]);
});

test('3D overview under reduced motion: a station switch is a crossfade, not a flight', async ({ browser }) => {
  const context = await browser.newContext({ reducedMotion: 'reduce' });
  await context.addInitScript(returningVisitor, [TOUR_KEY, WELCOME_KEY]);
  const page = await context.newPage();
  try {
    await page.goto('/?station=maitri');
    const scene = page.getByTestId('station-scene-3d');
    await expect(scene).toHaveAttribute('data-station', 'maitri');
    await openStation(page, 'bharati');
    await expect(scene).toHaveAttribute('data-station', 'bharati');
    await expect(scene).toHaveAttribute('data-transition', 'crossfade');
    await expect(scene).not.toHaveAttribute('data-flying', 'true');
  } finally {
    await context.close();
  }
});

// ═══════════════════════════════════════════════════════════════
//  Judge mode: public demo scenarios, the visitor sandbox, stories
//  These may run against the live deployment: a sandbox is private, and a demo scenario
//  is the public feature itself (it resets itself; each test ends the one it started).
// ═══════════════════════════════════════════════════════════════

/** A second, independent visitor (own cookies) — like another judge on another laptop. */
async function secondVisitor(browser) {
  const context = await browser.newContext();
  await context.addInitScript(returningVisitor, [TOUR_KEY, WELCOME_KEY]);
  return { context, page: await context.newPage() };
}

/** Wait until no demo scenario runs on `station` (another visitor's may be ending). */
async function waitForFreeStation(request, station) {
  await expect.poll(async () => {
    const snap = await (await request.get(`${API}/api/station/${station}/state`)).json();
    return Boolean(snap.publicDemo?.[station]);
  }, { timeout: 150_000, intervals: [3000], message: `a demo scenario kept running on ${station}` }).toBe(false);
}

test('judge mode: two visitors\' sandboxes are isolated, and the shared state is untouched', async ({ page, browser, request }) => {
  test.skip(!(await judgeMode(request)).sandbox, 'VISITOR_SANDBOX is off on this stack');
  const { consoleErrors, failedRequests } = watchForProblems(page);
  const ITEM = 'maitri-water';
  const shared = async () => (await (await request.get(`${API}/api/logistics?stationId=maitri`)).json()).items.find((i) => i.id === ITEM);
  const before = await shared();

  // Visitor A edits the ledger: it asks, says "sandbox", and shows the tag.
  await page.goto('/?module=logistics&station=maitri');
  await expect(page.getByTestId('sandbox-chip')).toBeVisible();
  await expect(page.getByTestId('sandbox-notice')).toContainText('changes are private and reset after 1 hour');
  await page.getByTestId(`ledger-edit-${ITEM}`).click();
  const next = String(Math.max(1, Math.round(before.current / 2)));
  await page.getByTestId('ledger-current').fill(next);
  await page.getByTestId('ledger-save').click();
  await page.getByTestId('confirm-ok').click();
  await expect(page.getByTestId('toast')).toContainText('in your sandbox');
  await expect(page.getByTestId(`ledger-row-${ITEM}`).getByTestId('sandbox-tag')).toBeVisible();

  // Visitor B (another browser) and the shared state still see the original value.
  const b = await secondVisitor(browser);
  try {
    await b.page.goto('/?module=logistics&station=maitri');
    await expect(b.page.getByTestId(`ledger-row-${ITEM}`)).toBeVisible();
    await expect(b.page.getByTestId(`ledger-row-${ITEM}`).getByTestId('sandbox-tag')).toHaveCount(0);
    expect((await shared()).current).toBe(before.current);

    // A's sandbox resets on request.
    await page.getByTestId('sandbox-reset').click();
    await page.getByTestId('confirm-ok').click();
    await expect(page.getByTestId('toast')).toContainText('sandbox was reset');
    await expect(page.getByTestId(`ledger-row-${ITEM}`).getByTestId('sandbox-tag')).toHaveCount(0);
  } finally {
    await b.context.close();
  }

  // Shared-state routes stay team-only for anonymous visitors.
  for (const [path, data] of [['/api/sim/mode', { mode: 'reanalysis' }], ['/api/ncpor/ingest', undefined],
    ['/api/connection/toggle?stationId=maitri', undefined]]) {
    expect((await request.post(`${API}${path}`, data ? { data } : {})).status(), path).toBe(401);
  }
  expect(consoleErrors, 'console errors in the sandbox').toEqual([]);
  expect(failedRequests, 'failed requests in the sandbox').toEqual([]);
});

test('judge mode: a visitor\'s own threshold drives their own alerts only', async ({ page, browser, request }) => {
  test.skip(!(await judgeMode(request)).sandbox, 'VISITOR_SANDBOX is off on this stack');
  const { consoleErrors, failedRequests } = watchForProblems(page);
  // Any sensor with a high threshold whose reading leaves room for a warning below it.
  const state = await (await request.get(`${API}/api/station/maitri/state`)).json();
  const cfg = await (await request.get(`${API}/api/admin/config?stationId=maitri`)).json();
  const pick = Object.entries(cfg.thresholdRules).map(([sensor, rule]) => {
    const value = state.sensors?.[rule.building]?.[sensor];
    const high = cfg.thresholds[sensor]?.high;
    if (!high || typeof value !== 'number') return null;
    const warning = Math.max(rule.min, Math.floor(value) - 1);
    const ok = warning < value && (high.critical == null || warning < high.critical) && !(high.warning <= value);
    return ok ? { sensor, warning: String(warning) } : null;
  }).find(Boolean);
  test.skip(!pick, 'no sensor currently leaves room for a test threshold below its reading');
  const { sensor, warning } = pick;

  // Visitor A lowers the coolant warning below the current reading, in their sandbox.
  await page.goto('/?module=admin&station=maitri');
  await page.getByTestId('admin-tab-thresholds').click();
  await page.locator(`[data-threshold="${sensor}.high.warning"]`).fill(warning);
  await page.getByLabel('Your name (recorded with the change)').fill('E2E judge');
  await page.getByTestId('admin-save').click();
  await expect(page.getByTestId('confirm-dialog')).toContainText('Only you see them');
  await page.getByTestId('confirm-ok').click();
  await expect(page.getByTestId('toast')).toContainText('Your alerts now use them');

  // A's alert centre has their own alert, tagged; B's and the shared alerts do not.
  const ownAlert = (p) => p.getByTestId('alert-card').filter({ has: p.getByText('Your threshold') });
  await page.getByTestId('alerts-pill').click();
  await expect(ownAlert(page)).toHaveCount(1, { timeout: 15_000 });
  await expect(ownAlert(page)).toContainText('your sandbox threshold');
  const b = await secondVisitor(browser);
  try {
    await b.page.goto('/?station=maitri');
    await b.page.getByTestId('alerts-pill').click();
    await expect(b.page.getByTestId('alert-drawer')).toBeVisible();
    await expect(ownAlert(b.page)).toHaveCount(0);
  } finally {
    await b.context.close();
  }
  const shared = await (await request.get(`${API}/api/alerts?stationId=maitri`)).json();
  expect(shared.activeAlerts.filter((a) => String(a.id).startsWith('SBX-'))).toEqual([]);

  // Resetting the sandbox puts A back on the station's thresholds.
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('alert-drawer')).toBeHidden();
  await page.getByTestId('thresholds-form').getByTestId('sandbox-reset').click();
  await page.getByTestId('confirm-ok').click();
  await expect(page.getByTestId('toast')).toContainText('sandbox was reset');
  expect(consoleErrors, 'console errors').toEqual([]);
  expect(failedRequests, 'failed requests').toEqual([]);
});

test('judge mode: anyone can run a demo scenario, every visitor sees the banner, and it can be ended', async ({ page, browser, request }) => {
  test.skip(!(await judgeMode(request)).publicDemo, 'PUBLIC_DEMO is off on this stack');
  const { consoleErrors, failedRequests } = watchForProblems(page);
  await waitForFreeStation(request, 'bharati');
  await page.goto('/?station=bharati');
  await page.getByTestId('try-demo').click();
  await expect(page.getByTestId('demo-public-note')).toContainText('reset automatically after 2 minutes');
  await page.getByTestId('demo-scenario-water_crisis').click();
  await page.getByTestId('confirm-ok').click();
  const b = await secondVisitor(browser);
  try {
    const banner = page.getByTestId('demo-banner');
    await expect(banner).toContainText('Demo scenario running: Water system alert (started by a visitor), resets in');
    await expect(banner).toContainText('Simulated');
    // Another visitor, on the other station, sees it too. The banner is part of the shell,
    // so B uses a light page: two software-WebGL 3D scenes on a CI runner starve each other.
    await b.page.goto('/?module=logistics&station=maitri');
    await expect(b.page.getByTestId('demo-banner')).toContainText('at Bharati', { timeout: 30_000 });
    // A second scenario on the same station is refused politely.
    const busy = await b.page.request.post(`${API}/api/sim/inject/co2_spike?stationId=bharati`);
    expect([409, 429]).toContain(busy.status());
    expect((await busy.json()).detail.message).toMatch(/try again in|start another in/);
    // The event log records it as a public demo.
    await page.getByTestId('demo-control-panel-close').click();
    await page.keyboard.press('Escape');
  } finally {
    // End the scenario we started (visitors may end a visitor-started one).
    await page.request.post(`${API}/api/sim/reset?stationId=bharati`);
    await b.context.close();
  }
  await expect(page.getByTestId('demo-banner')).toHaveCount(0, { timeout: 15_000 });
  const snap = await (await request.get(`${API}/api/station/bharati/state`)).json();
  expect(snap.eventTimeline.some((e) => /public demo/.test(e.message))).toBe(true);
  expect(consoleErrors, 'console errors in the public demo').toEqual([]);
  expect(failedRequests.filter((f) => !/ 40[39] | 429 /.test(f)), 'failed requests in the public demo').toEqual([]);
});

test('weather and administration say how fresh the NCPOR live data is', async ({ page }) => {
  const { consoleErrors, failedRequests } = watchForProblems(page);
  await page.goto('/?module=environmental&station=bharati&tour=off');
  const line = page.getByTestId('ncpor-freshness-bharati');
  await expect(line).toBeVisible();
  // One of the honest states: synced ("Last synced … · N values · next sync in …"), not yet,
  // off, or a clear error with the last good data (e.g. the offline compose stack in CI).
  await expect(line).toContainText(/Last synced|Not synced yet|automatic sync off|NCPOR page unreachable|NCPOR sync failing/);
  await page.getByTestId('ncpor-info').hover();
  await expect(page.getByRole('tooltip')).toContainText('not independently confirmed');
  await page.goto('/?module=admin&tour=off');
  await expect(page.getByTestId('ncpor-freshness-maitri')).toBeVisible();
  await expect(page.getByTestId('ncpor-freshness-bharati')).toBeVisible();
  expect(consoleErrors, 'console errors').toEqual([]);
  expect(failedRequests, 'failed requests').toEqual([]);
});

/** Play a story from the picker (or a deep link) to its last step. */
async function playStory(page, id) {
  const popover = page.getByTestId('tour-popover');
  await expect(popover).toBeVisible({ timeout: 30_000 });
  let guard = 0;
  while (await popover.count() && guard < 15) {
    guard += 1;
    const step = await popover.getAttribute('data-tour-step');
    const next = page.getByTestId('tour-next');
    await expect(next).toBeEnabled({ timeout: 30_000 });
    const label = await next.textContent();
    await next.click();
    if (/Finish story/.test(label)) break;
    await expect.poll(async () => (await popover.count()) === 0 || (await popover.getAttribute('data-tour-step')) !== step,
      { timeout: 45_000, message: `story ${id} stuck after step ${step}` }).toBe(true);
  }
  await expect(popover).toHaveCount(0, { timeout: 15_000 });
}

for (const [label, viewport] of [['desktop', { width: 1440, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
  for (const id of ['blizzard', 'generator', 'fuel', 'linkloss']) {
    test(`story "${id}" completes on ${label}`, async ({ page, request }) => {
      const judge = await judgeMode(request);
      test.skip(id !== 'fuel' && !judge.publicDemo, 'PUBLIC_DEMO is off on this stack');
      test.skip(id === 'fuel' && !judge.sandbox, 'VISITOR_SANDBOX is off on this stack');
      test.setTimeout(240_000);
      const { consoleErrors, failedRequests } = watchForProblems(page);
      const station = id === 'generator' || id === 'linkloss' ? 'bharati' : 'maitri';
      if (id !== 'fuel') await waitForFreeStation(request, station);
      // On a live deployment one visitor may start a scenario per minute.
      if (id !== 'fuel' && IS_REMOTE) await page.waitForTimeout(61_000);
      await page.setViewportSize(viewport);
      await page.goto(`/?story=${id}`);                         // deep link
      await expect(page).not.toHaveURL(/story=/);
      await playStory(page, id);
      if (id !== 'fuel') {
        // The story reset its scenario at the end.
        await expect.poll(async () => Boolean((await (await request.get(`${API}/api/station/${station}/state`)).json()).publicDemo?.[station]),
          { timeout: 20_000 }).toBe(false);
        if (id === 'linkloss') {
          // The link is back and what the station recorded meanwhile was synced.
          const link = (await (await request.get(`${API}/api/station/bharati/state`)).json()).link;
          expect(link.up).toBe(true);
          expect(link.lastSync.readings).toBeGreaterThan(0);
        }
      } else {
        await page.request.post(`${API}/api/sandbox/reset`);
      }
      expect(consoleErrors, `console errors in story ${id}`).toEqual([]);
      expect(failedRequests, `failed requests in story ${id}`).toEqual([]);
    });
  }
}

test('stories: the picker explains when another scenario is running, and Share this view copies the link', async ({ page, browser, request }) => {
  const judge = await judgeMode(request);
  test.skip(!judge.publicDemo || !judge.sandbox, 'judge mode is off on this stack');
  await waitForFreeStation(request, 'maitri');
  const b = await secondVisitor(browser);
  try {
    // Another visitor runs a different scenario at Maitri. On a live deployment one IP may
    // start a scenario per minute, and the previous test may have just started one.
    if (IS_REMOTE) await page.waitForTimeout(61_000);
    const started = await b.page.request.post(`${API}/api/sim/inject/co2_spike?stationId=maitri`);
    expect(started.ok(), await started.text()).toBeTruthy();
    await page.goto('/?station=maitri');
    await page.getByTestId('help-open').click();
    await page.getByTestId('help-stories').click();
    await expect(page.getByTestId('story-note-blizzard')).toContainText(/Another scenario is running at Maitri; try again in \d:\d\d/);
    await expect(page.getByTestId('story-play-blizzard')).toBeDisabled();
    await expect(page.getByTestId('story-play-fuel')).toBeEnabled();
    await page.keyboard.press('Escape');
  } finally {
    await b.page.request.post(`${API}/api/sim/reset?stationId=maitri`);
    await b.context.close();
  }
  // Share this view: copies the current URL (page + station).
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/?module=energy&station=bharati');
  await page.getByTestId('topbar-more').click();
  await page.getByTestId('menu-share').click();
  await expect(page.getByTestId('toast')).toContainText(/Link copied|Copy this link/);
  // About Aurora opens from the ⋮ menu.
  await page.getByTestId('topbar-more').click();
  await page.getByTestId('menu-about').click();
  await expect(page.getByTestId('about-dialog')).toContainText('Where the data comes from (provenance)');
  await expect(page.getByTestId('about-dialog')).toContainText('github.com/Saeesh-Vele/SIH2026A');
});


// ── Aurora assistant ─────────────────────────────────────────────────────────
// The stack under test has GROQ_API_KEY cleared, so these also prove Aurora works with
// the LLM disabled: commands are parsed in the browser, answers come from station data.

/** axe on one region: no serious or critical violations. */
async function expectAccessible(page, selector, what) {
  const results = await new AxeBuilder({ page }).include(selector).analyze();
  const bad = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.impact}: ${v.id} (${v.nodes.length}) ${v.nodes[0]?.target}`);
  expect(bad, `axe: serious/critical violations in ${what}`).toEqual([]);
}

async function askAurora(page, text) {
  const before = await page.getByTestId('msg-aurora').count();
  await page.getByTestId('assistant-input').fill(text);
  await page.getByTestId('assistant-input').press('Enter');
  await expect(page.getByTestId('msg-aurora')).toHaveCount(before + 1, { timeout: 20_000 });
  return page.getByTestId('msg-aurora').last();
}

test('Aurora: text commands navigate and highlight, answers come from station data with the LLM disabled', async ({ page }) => {
  const { consoleErrors, failedRequests } = watchForProblems(page);
  await page.goto('/?station=maitri');
  await expect(page.getByTestId('data-source-badge')).toHaveAttribute('data-source', /simulator|physics-fallback/, { timeout: 30_000 });
  await page.getByTestId('assistant-open').click();
  const panel = page.getByTestId('assistant-panel');
  await expect(panel).toBeVisible();
  await expect(page.getByTestId('assistant-privacy')).toContainText(/may send audio to the browser vendor|not supported in this browser/);
  await expect(page.getByTestId('assistant-offline')).toContainText('Answering from station data only');

  // A page at another station, with an Undo chip.
  let reply = await askAurora(page, 'Open the energy grid for Bharati');
  await expect(page).toHaveURL(/module=energy/);
  await expect(page).toHaveURL(/station=bharati/);
  await expect(reply).toContainText('Opened Energy grid for Bharati');
  await reply.getByTestId('action-chip').getByLabel(/Undo/).click();
  await expect(page).toHaveURL(/station=maitri/);
  await expect(page).not.toHaveURL(/module=energy/);

  // What depends on the generator: Infrastructure, with the chain highlighted.
  reply = await askAurora(page, 'Show me what depends on the generator');
  await expect(reply).toContainText('depend on the Generator Shed');
  await expect(page).toHaveURL(/module=infrastructure/);
  await expect(page.getByTestId('dep-node-generator')).toHaveAttribute('data-highlighted', 'true');
  await expect(page.getByTestId('building-tile-livingQuarters')).toHaveAttribute('data-highlighted', 'true');
  await expect(page.getByTestId('highlight-strip')).toContainText('Generator Shed');

  // Grounded answers, from data only.
  reply = await askAurora(page, "What's the fuel situation at Maitri?");
  await expect(reply).toContainText(/fuel store is [\d.,]+ kL/);
  reply = await askAurora(page, 'Explain the current anomaly');
  await expect(reply).toContainText(/detector|anomaly/i);
  await expect(reply.getByTestId('msg-mode')).toContainText('Answering from station data only');

  // A named what-if runs read-only and shows on the What-if page.
  reply = await askAurora(page, 'What happens if there is a blizzard at Maitri?');
  await expect(reply).toContainText('Rule-based what-if');
  await expect(page.getByTestId('whatif-result')).toBeVisible();

  // Mute is a chip with Undo; settings open.
  reply = await askAurora(page, 'Mute');
  await expect(page.getByTestId('assistant-mute')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('assistant-settings').click();
  await expect(page.getByTestId('assistant-settings-panel')).toBeVisible();
  await expectAccessible(page, '[data-testid=assistant-panel]', 'the assistant panel');
  await expectAccessible(page, '[data-testid=highlight-strip]', 'the highlight strip');

  // Launch points: palette ("Ask Aurora: …") and the shortcuts dialog.
  await page.getByTestId('assistant-close').click();
  await expect(panel).toHaveCount(0);
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByTestId('palette-input').fill('how windy is it');
  await page.getByTestId('cmd-ask-aurora').click();
  await expect(page.getByTestId('msg-user').last()).toHaveText(/how windy is it/);
  await expect(page.getByTestId('msg-aurora').last()).toContainText(/wind/i, { timeout: 20_000 });
  expect(consoleErrors, 'console errors while using Aurora').toEqual([]);
  expect(failedRequests, 'failed requests while using Aurora').toEqual([]);
});

test('Aurora: without speech recognition the panel falls back to text', async ({ page }) => {
  await page.addInitScript(() => { delete window.SpeechRecognition; delete window.webkitSpeechRecognition; });
  await page.goto('/?station=maitri&module=energy');
  await page.getByTestId('assistant-open').click();
  await expect(page.getByTestId('assistant-mic')).toBeDisabled();
  await expect(page.getByTestId('assistant-privacy')).toContainText('Voice input is not supported in this browser, so type instead.');
  const reply = await askAurora(page, 'open the weather page');
  await expect(reply).toContainText('Opened Weather');
  await expect(page).toHaveURL(/module=environmental/);
});

test('Aurora: a state-changing action asks first; my generator failure opens the page, highlights the chain and is briefed at High', async ({ page, request }) => {
  test.skip(!ALLOW_WRITES, LIVE_WRITES_SKIPPED);
  const judge = await judgeMode(request);
  test.skip(judge.writeProtected && !judge.publicDemo && !ADMIN_TOKEN, 'scenarios need PUBLIC_DEMO or the team token here');
  test.setTimeout(240_000);
  await waitForFreeStation(request, 'bharati');
  await page.goto('/?station=bharati');
  await expect(page.getByTestId('data-source-badge')).toHaveAttribute('data-source', /simulator|physics-fallback/, { timeout: 30_000 });
  // Without the public demo, only the signed-in team may start a scenario (Aurora refuses otherwise).
  if (judge.writeProtected && !judge.publicDemo) await operatorLogin(page);
  await page.getByTestId('assistant-open').click();
  try {
    // Cancelled: nothing starts.
    await page.getByTestId('assistant-input').fill('trigger a generator failure');
    await page.getByTestId('assistant-input').press('Enter');
    await expect(page.getByTestId('confirm-dialog')).toContainText('Run “Generator failure” at Bharati?');
    await page.getByTestId('confirm-cancel').click();
    await expect(page.getByTestId('msg-aurora').last()).toContainText('Cancelled');
    const idle = await (await request.get(`${API}/api/station/bharati/state`)).json();
    expect(idle.publicDemo?.bharati).toBeFalsy();

    // Confirmed: the visitor's own incident takes over the page.
    await page.getByTestId('assistant-input').fill('trigger a generator failure');
    await page.getByTestId('assistant-input').press('Enter');
    await page.getByTestId('confirm-ok').click();
    const card = page.getByTestId('incident-card');
    await expect(card).toHaveAttribute('data-incident', 'generator_failure', { timeout: 60_000 });
    await expect(page).toHaveURL(/module=energy/);
    await expect(page.getByTestId('highlight-strip')).toHaveAttribute('data-ids', /generator.*heating/);
    await expect(page.getByTestId('incident-risk')).toContainText(/High|Critical/);
    const briefing = page.locator('[data-testid=msg-aurora][data-kind=incident]');
    await expect(briefing).toContainText('Generator failure detected at Bharati');
    await expect(briefing).not.toContainText(/Risk is (low|nominal|moderate)/);
    await expect(card).toContainText('Example procedure, not an official NCPOR procedure');
    await page.getByTestId('incident-step-0').check();
    await page.getByTestId('incident-next').click();
    await expect(page.getByTestId('msg-aurora').last()).toContainText('Step 2 of 5');
    await expectAccessible(page, '[data-testid=assistant-panel]', 'the panel with an incident card');
  } finally {
    await request.post(`${API}/api/sim/reset?stationId=bharati`, { headers: WRITE_HEADERS });
  }
  await expect(page.getByTestId('incident-card')).toHaveAttribute('data-status', 'resolved', { timeout: 90_000 });
  await expect(page.locator('[data-testid=msg-aurora][data-kind=summary]')).toContainText(/resolved after .* 1 of 5 steps completed/);
});

test('Aurora: another visitor\'s incident shows the floating card and does not take over the page', async ({ page, browser, request }) => {
  test.skip(!ALLOW_WRITES, LIVE_WRITES_SKIPPED);
  const judge = await judgeMode(request);
  test.skip(judge.writeProtected && !judge.publicDemo, 'another visitor cannot start a scenario on this stack');
  test.setTimeout(240_000);
  await waitForFreeStation(request, 'maitri');
  await page.goto('/?station=maitri&module=logistics');
  await expect(page.getByTestId('data-source-badge')).toHaveAttribute('data-source', /simulator|physics-fallback/, { timeout: 30_000 });
  await page.getByTestId('nav-logistics').click();                 // a user gesture
  const b = await secondVisitor(browser);
  try {
    if (IS_REMOTE) await page.waitForTimeout(61_000);
    const started = await b.page.request.post(`${API}/api/sim/inject/heating_failure?stationId=maitri`);
    expect(started.ok(), await started.text()).toBeTruthy();
    const float = page.getByTestId('incident-float');
    await expect(float).toContainText('Heating failure · Maitri', { timeout: 60_000 });
    await expect(page.getByTestId('assistant-panel')).toHaveCount(0);
    await expect(page).toHaveURL(/module=logistics/);
    await expectAccessible(page, '[data-testid=incident-float]', 'the floating incident card');
    await page.getByTestId('incident-float-show').click();
    await expect(page).toHaveURL(/module=infrastructure/);
    await expect(page.getByTestId('highlight-strip')).toContainText('Heating Zone A');
    await expect(page.getByTestId('incident-card')).toBeVisible();
  } finally {
    await b.page.request.post(`${API}/api/sim/reset?stationId=maitri`);
    await b.context.close();
  }
});
