# Changelog

## Aurora assistant — 2026-10-03 (PR #11)

Replaces the overview's continuous-listening "Voice assistant" with **Aurora**, a voice + text
operator assistant. Design, checkpoint screenshots and transcripts: `docs/assistant/`.

- **Action layer.** Twelve whitelisted UI actions (`simulator/assistant_actions.json`), validated
  by the backend for LLM tool calls and again in the browser. Each run shows a chip, with Undo where
  it makes sense. `startStory` and `triggerDemoScenario` are confirmed by click or voice and use the
  normal routes, so the public-demo and token rules are unchanged.
- **Grounded answers.** Answers come only from `GET /api/assistant/context`: telemetry with
  provenance, alerts, the anomaly detector, the decision engine and its audit trail, the dependency
  graph and cascades, and the replay time. An LLM reply quoting a number that isn't in the context
  is replaced by the deterministic answer.
- **LLM optional.** Common commands are parsed in the browser and lookups answered from data.
  Groq `openai/gpt-oss-20b` routes unrecognised requests to tools, and `openai/gpt-oss-120b` phrases
  explanations, both via the simulator's `/api/llm/chat` with their own caps. Without Groq, Aurora
  answers "from station data only".
- **Voice.** Web Speech API push-to-talk (mic button or hold V), conversation mode, live captions,
  text fallback where recognition is missing (Firefox), a privacy note, and optional Hindi.
- **Incident mode.** Eight example playbooks (`simulator/playbooks.json`, not official NCPOR
  procedures). New critical alerts, link loss or a serious anomaly open an incident card: what failed,
  a labelled likely cause, affected systems, risk and a checklist.
  - The risk is never stated below the playbook's baseline, and opening an incident asks the decision
    engine to re-evaluate.
  - The visitor's own incidents open the page, highlight the dependency chain and are spoken. Other
    visitors' incidents show a floating card with "Show me".
  - Updates are debounced to one spoken update per 20 s unless the risk escalates. A summary follows
    on resolution.
- **Integration.** "Ask Aurora" on the welcome card, a tour step, the command palette (including
  "Ask Aurora: …" for any typed text) and the shortcuts dialog.
- **Startup JS 495.8 → 482.8 kB:** the startup station config is a build-time core view. Groq's
  daily explanation cap went from 120 to 100.

## UI redesign — 2026-10-02 (phases 1A → 1C, PR #1)

The whole frontend was rebuilt on one design system. The 3D scene itself is unchanged.
Design notes, decisions and every review checkpoint's screenshots are in
[docs/ui-redesign.md](docs/ui-redesign.md) (§11–§15) and `docs/ui-redesign/`.

### 1A — design system, shell, Energy grid, Overview HUD

- MUI 9 theme with CSS variables. One token file (`src/theme/tokens.js`), dark (default) and
  light schemes, and every text and status colour measured against WCAG AA. Fonts are IBM
  Plex Sans and Plex Mono, self-hosted.
- **Shell.** One top bar: station switcher, data-source / link / alert / event chips, and
  "Sign in" visible at every width. The sidebar has Monitor / Operate / Analyse / System
  sections and a station mini-card (south-polar locator, mean solar time with IST, and the
  computed polar day/night line). Phones get a nav drawer and a ⋮ menu.
- **Energy grid and Overview HUD** rebuilt: bento KPIs with sparklines, and charts showing
  raw samples plus a moving average.
- **Physics in the snapshot.** The energy breakdown travels inside the telemetry snapshot,
  so every figure shares one tick. `GET /api/history` serves the last 30 min.
- **Replay clock.** Deltas, averages and day/night run on the ERA5 replay clock and are
  labelled "(replay time)". The replay's UTC offset is inferred from the solar-radiation peak.
- **Bugs fixed:**
  - F1: module pages stacked instead of replacing each other (also hotfixed on `main`).
  - F3: the Read-only control was invisible.
  - The overview cards covered the station model.

### 1B — every page and overlay

- **Monitor:** Weather (live figures plus stored observations with five analysis tabs) and
  Infrastructure (building tiles and a computed dependency map). The building panel now shows
  live readings (F2).
- **Operate / Analyse:** Logistics, Remote commands, What-if, AI diagnostics, Reports (with a
  print view) and the Twin inspector.
- **System:** Administration (data sources, alert thresholds, access, station configuration).
- **Overlays:** the alert centre (Active / Acknowledged / History), telemetry link, event log,
  Demo control and the 2D no-WebGL fallback.
- **Command palette (⌘K / Ctrl+K)**, keyboard shortcuts (`?`, `g` + letter, Esc), and URL state
  (`?module=&station=`).
- **Confirm first, then a toast.** Every state-changing action confirms before it runs and
  reports its result in a toast.
- **Removed:** the legacy panels and their CSS, framer-motion, react-icons and three unused
  font families. CSS went from 83 kB to 9 kB and fonts from 1.9 MB to 446 kB.

### 1C — guided tour and polish

- **Guided tour** (driver.js 1.8, lazy-loaded, 35 kB):
  - 12 steps; auto-starts once on a first visit, after the first telemetry snapshot.
  - Remembered in `localStorage` under `aurora-tour-v1` (versioned; falls back to memory if
    storage is blocked).
  - Restart it from Help, the `?` dialog or the command palette.
  - Next / Back / Skip tour, "3 of 12", and ← → Esc. Focus moves to Next on each step and
    returns to the page at the end.
  - On phones, sidebar steps open the drawer, and the Demo control step points at the ⋮ menu.
  - Themed in both schemes, and the motion respects reduced-motion settings.
  - "Tour this page" for Weather, Infrastructure, What-if and Administration → thresholds.
  - `?tour=off` and `?tour=start`.
- **Polish:** see [docs/ui-redesign.md §15](docs/ui-redesign.md) for the full list.
  - A visible keyboard focus ring on every control (the global no-ripple setting had left
    none), and a "Skip to content" link.
  - Sign-in from the command palette, plus a toast on sign-in and sign-out.
  - Thresholds are read-only when signed out.
  - Sign in reappears when the backend comes back.
  - Clearer simulator-offline and backend-offline states.

### Fabricated or overstated claims removed

- **Energy grid** totals and load split were hardcoded. They now come from the physics
  snapshot.
- **Weather:**
  - "Prophet / Trend" was a degree ≤ 2 polynomial trend, and its band is ±1.96σ of the fit
    residuals (only ARIMA's is a prediction interval).
  - The anomaly features were not a "physics expectation".
  - The frostbite text said "< 30 mins" for any wind chill above −40 °C; it now uses the
    Environment Canada bands, with the source cited.
  - The risk engine claimed "+42 % heat loss" and "+28 kW" that nothing computes.
- **Infrastructure:**
  - "AI health" was the rule-based alert roll-up; it is now "Station health".
  - A "warning" health was shown as "Critical".
- **What-if:**
  - It claimed to run "through the physics model"; it applies fixed deltas to the snapshot.
  - Invented specifics, all removed: a "Volvo Penta" gen-set, a "120 kWh" battery, "3.8 h"
    autonomy at "18 kW", "180 → 58 days" fuel, valve "SV-04" / "Day Tank #2", a named resupply
    ship, "240 days" margin, "~14 %" savings and an "NCPOR AWS baseline".
  - When data was missing it showed fallback weather and power figures and an "80 CRITICAL"
    score, and it labelled the suggestion "AI recommended mitigation".
- **Remote commands** showed "last request" values before any request was made, and
  acknowledging was not gated on sign-in.
- **Logistics** said "no authentication", and added its own client-side low-stock rules on top
  of the backend's reorder level.
- **AI diagnostics:** a cause's "confidence %" is a match strength, not a probability, and the
  decision "confidence" is a rule-based label.
- **Reports:**
  - The wind chill formula was misattributed.
  - The CSV wrote "null Days".
  - "SUFFICIENT" meant only "above reorder level".
  - Generator values were always labelled model-derived, even in the browser demo.
  - The latest stored observation had no time.
- **Twin inspector:**
  - The environment was always labelled "reanalysis (ERA5)" and the equipment always "model".
  - A 15 % waste-heat default was applied silently.
  - The replay time had no time zone.
- **Administration** promised "role-based access" and showed demo users with access badges.
  There is one operator token; the roles are labelled examples.
- **Event log** claimed a "detection → analysis → action → outcome" log, with event types the
  simulator never logs.
- **Demo control:**
  - The generator scenario claimed to "cascade to heating, water, comms", and the blizzard to
    make "heating demand spike".
  - Neither is simulated: injections override only their own sensors, and each scenario now
    lists its targets.
- **Link drawer** said link loss is simulated "in the browser"; the backend's flag changes too.
- **2D fallback** always showed the first station's buildings.
- **Page metadata** (`index.html`) promised "AI-powered forecasting and smart automation".
- **Polish pass (1C):**
  - With the backend unreachable, Logistics said "No inventory items" and "Every item is
    above its reorder level".
  - With the backend unreachable, Infrastructure credited the backend alert engine for
    browser-demo alerts.
  - The AI page showed the internal simulator URL.
