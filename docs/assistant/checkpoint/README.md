# Aurora assistant: checkpoint after Priority 2

Branch `feat/aurora-assistant`. Priorities 1 and 2 are done; Priority 3 (welcome card, tour,
palette, shortcuts dialog, e2e tests, release) waits for approval.

All screenshots come from the local stack (backend + simulator + Vite) with live ERA5 replay data
and Groq enabled. Chromium was used for 1–4 and Playwright's Firefox 155 for 5. The demo fault was
started with `POST /api/sim/inject/generator_failure` (team mode, no token locally).

| # | What | 1440 px | 390 px |
|---|------|---------|--------|
| 1 | Panel mid-conversation with action chips (Undo on each) and the page it opened | [1440](1-conversation-action-chips-1440.png) | [390](1-conversation-action-chips-390.png) |
| 2 | Grounded answers with data values (fuel at Maitri; anomaly score vs threshold), details expanded | [1440](2-grounded-answer-1440.png) | [390](2-grounded-answer-390.png) |
| 3 | Generator-failure incident card: what failed, likely cause (labelled), affected systems, risk; Energy grid opened, dependency chain highlighted | [1440](3-incident-generator-failure-1440.png) | [390](3-incident-generator-failure-390.png) |
| 3b | The same incident's checklist (step 1 ticked, next step marked) | [1440](3b-incident-checklist-1440.png) | [390](3b-incident-checklist-390.png) |
| 4 | Incident resolved: summary (duration, affected systems, steps completed) | [1440](4-incident-resolved-1440.png) | — |
| 5 | Text fallback in Firefox (no SpeechRecognition): mic disabled, note shown, typed question answered | [1440](5-text-fallback-firefox-1440.png) | [390](5-text-fallback-firefox-390.png) |

## Transcript: five exchanges

These were typed into the panel. Spoken input runs through the same `handle()` path. It can't be
exercised in headless browsers, so it still needs a manual check in Chrome (see "Not verified" below).
"Chips" are the visible action chips; every chip with ↶ has Undo.

1. **You:** Open the energy grid for Bharati *(viewing Maitri)*
   **Aurora:** Opened Energy grid for Bharati.
   Chips: `Opened Energy grid for Bharati ↶`. Parsed in the browser; no network call.
2. **You:** Show me what depends on the generator
   **Aurora:** 6 systems depend on the Generator Shed: Heating Zone A, Heating Zone B, Water
   Treatment, Comms Tower, Living Quarters and Research Lab.
   Chips: `Showing what depends on Generator Shed ↶`. This opens Infrastructure, outlines the
   7 components on the tiles and the dependency map, and shows the "Highlighted by Aurora" strip.
   No LLM call.
3. **You:** What's the fuel situation at Maitri?
   **Aurora:** At Maitri the fuel store is 142.0 kL and the generator is burning 16.1 L/hr. At this
   rate that is about 367 days of fuel. No fuel alerts are active.
   Suggestion: `Switch to Maitri`. Details: MODEL-DERIVED provenance and the autonomy formula.
   A lookup, so no LLM call.
4. **You:** Explain the current anomaly
   **Aurora:** No anomaly at Bharati: the detector score is 0.361, below its threshold of 0.564,
   and the largest residual is 0.0 sigma.
   Note: *Phrased by the LLM from station data; numbers checked against it.* Suggestion:
   `Open AI diagnostics`. One gpt-oss-120b call.
5. **You:** What happens if there's a blizzard at Maitri? *(viewing Bharati; separate run)*
   **Aurora:** Rule-based what-if for blizzard at Maitri; nothing in the twin changes. Sustained
   wind 58 km/h (16.1 m/s). Outside temperature −31.9 °C. Rule-based risk 88 of 100, critical.
   Chips: `Switched to Maitri ↶` `Ran what-if: Blizzard ↶`. The What-if page shows the same
   result; no LLM call.

Also tested: "Why is Heating Zone A in warning?" while it was normal →
*"Heating Zone A is not in warning; its status is normal with no alerts."* (LLM-phrased,
grounding check passed). "Start the blizzard story" asks for confirmation first, "Mute" turns the
voice off (with Undo), and "Stop" stops speech.

## One full incident: generator failure at Bharati

Times are from the injection (t = 0). The user had already interacted with the page, auto-navigate
and voice were on, and nothing was clicked except as noted.

| t | What happened |
|---|---------------|
| 0 s | `generator_failure` injected at Bharati (shared demo scenario). |
| 5.3 s | The anomaly detector flags the residuals first, so the incident opens as **warning** (playbook chosen by the candidate cause `generator_output_loss`). The panel opens, the Energy grid opens, and the components are highlighted with the chain *Generator Shed → Heating Zone A, Living Quarters, Heating Zone B, Research Lab, Water Treatment, Comms Tower*. Chip: `Opened Energy grid and highlighted the affected systems ↶`. |
| 5.3 s | Spoken and shown: *"Generator failure detected at Bharati. Heating Zone A, Living Quarters, Heating Zone B and 3 more may be affected. Risk is low. First, verify backup power. Next, check the affected electrical loads. Then, inspect the generator fault indicators. I've opened the Energy grid and highlighted the affected systems."* "Risk is low" is the decision engine's rating at that moment; it lags the alerts by a tick or two, and the card follows it. |
| ~7 s | The threshold alerts go critical, so the incident escalates. Spoken immediately (an escalation bypasses the 20 s limit): *"Generator failure at Bharati is now critical."* |
| ~15 s | Step 1 ticked on the card. **You:** "What should I do next?" **Aurora:** *"Step 2 of 5: Check the affected electrical loads and shed non-essential ones so the standby supply is not overloaded."* |
| ~20 s | Scenario reset. |
| 26.7 s | Alerts cleared for two observations, so the incident is resolved. The highlight clears and Aurora says: *"Generator failure at Bharati resolved after 22 seconds. Affected: Generator Shed, Heating Zone A, Living Quarters, Heating Zone B, Research Lab, Water Treatment and Comms Tower. 1 of 5 steps completed."* |

In an earlier run the decision engine's risk moved while the incident was open, and the visual
update *"Risk at Bharati changed from low to nominal."* followed. Non-escalating updates are
spoken at most once per 20 s, and only the latest one is kept.

## What is built

**Architecture (as specified)**
- **Action layer:** the 12 actions live in `simulator/assistant_actions.json`. The backend turns them
  into Groq tool schemas and validates every tool call; the browser validates again
  (`src/assistant/actions.js`) and runs them through the app's own setters. Unknown actions, extra
  arguments and bad ids are refused and shown as "Refused" chips. `startStory` and
  `triggerDemoScenario` are state-changing: they ask through `useConfirm` (which gained a `bind` hook
  so a spoken "yes"/"no" answers the same dialog) and call the normal routes. Visitors therefore
  still get the public-demo slot, cooldown and 403/409/429 messages, and a protected server still
  needs the token.
- **Grounding:** `GET /api/assistant/context` returns every sensor with its unit and provenance,
  the active alerts (with rule, threshold and direction), the anomaly result (score labelled "not a
  probability", candidate causes labelled "likely cause, based on a rule-based match against
  synthetic signatures"), the decision engine output (risk, rules, recommendation, compact audit
  trail), the dependency graph and live cascades, the link state and the replay time.
  - Every LLM reply goes through `numbers_grounded()`. If it quotes a number not in the context
    (the explanation model first tried to compute "10,470 hours"), the deterministic answer is used.
  - If the LLM claims the data has no answer while the data answer exists, the data answer is used.
- **LLM:** `openai/gpt-oss-20b` routes unrecognised requests to the tools; `openai/gpt-oss-120b`
  phrases explanations. Both run through a new internal simulator gateway, `/api/llm/chat`, so the
  key and budgets stay in one process. The router has its own caps
  (`GROQ_ROUTER_MAX_CALLS_PER_HOUR/DAY` = 30/120). Explanations share the existing caps (40/h,
  120/day) and the existing 120 s cache.
- **Without the LLM:** commands are parsed in the browser (`intents.js`). Lookups (fuel, sensor
  values, weather, generator, alerts, dependencies) are answered from data on the backend.
  Explanations fall back to the deterministic answer with *"Answering from station data only"*.
  Incident briefings never use the LLM.
- **Voice:** push-to-talk on the mic button or by holding V, plus an optional conversation mode,
  live captions, and a text box that always works. The browser fallback is detected, and the
  privacy note is shown. Settings: voice on/off, auto-navigate, speaking rate, conversation mode,
  English or Hindi (`hi-IN`, if the browser has the voice).
- **Lazy loading:** only `src/assistant/bus.js` (a tiny store) and the top-bar launcher are in the
  startup bundle. The host, panel, parser, incident engine and speech code are lazy chunks; the
  host mounts after the first telemetry snapshot.

**Priority 2**
- **Playbooks:** `simulator/playbooks.json` has 8 conservative example procedures: generator failure,
  heating failure, water system, CO₂, blizzard, satellite link loss, low fuel, and a fallback for an
  unexplained anomaly. Each has a meaning, typical causes (labelled, not a diagnosis), an
  affected-systems hint, a risk rationale and 4–5 steps (`do` for the checklist, `say` for speech).
  Each card states "Example procedure, not an official NCPOR procedure".
- **Incident engine:** `incidents.js` is a pure reducer, unit-tested.
  - It triggers on a new critical alert (shared or the visitor's own sandbox alerts), a satellite
    link loss, or a serious anomaly (detector flag plus a residual over its alarm gate).
  - It queues incidents by severity, tracks affected systems from the backend's cascade chains,
    follows the decision engine's risk, and resolves after two clear observations (with a 5 s
    heartbeat).
- **Gesture rule:** nothing is spoken and nothing navigates before the first pointer or key event,
  or while a tour or story runs. Incidents already present at page load are shown on the card only.
- **Controls:** dismiss, snooze (5 min), "what should I do next?", "done" (ticks the next step) and
  "repeat", by voice, text or button.

## Numbers

- **Startup JS:** 495.8 kB raw / 159.4 kB gzip before, **499.0 kB / 160.1 kB** now (budget
  < 500 kB). This is measured as the entry script plus its modulepreloads in `dist/index.html`.
- **Groq usage, measured:** an explanation is 1,705 prompt + 82 completion tokens (gpt-oss-120b).
  A routing call is 1,128 + 30 tokens (gpt-oss-20b).
  - **Per conversation** (5 turns: 2 commands, 1 lookup, 2 explanations): 2 calls, about 3.6k tokens.
    An unrecognised phrasing adds one router call (about 1.2k tokens).
  - **Per incident:** 0 calls.
  - The router's 120/day cap is about 140k of gpt-oss-20b's 200k free daily tokens.
  - On gpt-oss-120b, the existing 120/day cap is about 215k tokens if every call were an assistant
    explanation. That is slightly over the 200k free daily tokens; past that, Groq refuses with 429
    and Aurora falls back to data answers. See decision 2 below.
- **Tests:** pytest 500 passed (73 new: playbooks, whitelist, parser on the spec's examples, grounded
  answers, numeric check, routes with mocked LLM, gateway budget). Vitest 203 passed (40 new: intent
  parser, action validation, playbook selection, incident lifecycle, briefings). Existing e2e:
  27 passed, 1 skipped (unchanged). ruff and oxlint are clean (warnings only), and the build passes.

## Not verified yet (needs you or a real browser)

- **Real microphone and speaker:** headless browsers can't capture audio or play speech. Speech
  input, push-to-talk and conversation mode are wired to the Web Speech API but were not heard
  end to end. Please try them in Chrome; the live verification in Priority 3 covers this with a
  voice profile.
- **Docker images:** Docker isn't installed on this machine. `frontend.Dockerfile` now copies
  `simulator/assistant_actions.json`, which the bundle imports; CI and the deploy will build it.
- **nginx:** the new `aurora_assistant` limit (12/min, burst 4) on `/api/assistant/chat` follows the
  explain block but has not run under nginx yet.

## Decisions for you

1. **Auto-open on a new incident:** with a prior gesture, the panel opens and the page navigates.
   Without one, only the floating card appears. Keep this?
2. **gpt-oss-120b daily cap:** lower `GROQ_MAX_CALLS_PER_DAY` from 120 to 100 to stay under the free
   200k tokens/day with the larger assistant prompt, or keep 120 and accept the graceful fallback?
3. **Hindi:** input and LLM answers work in Hindi; deterministic answers and briefings stay in
   English. Is that acceptable as the "optional" scope?
