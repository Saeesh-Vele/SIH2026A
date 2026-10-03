/* ═══════════════════════════════════════════════════════════════
   Aurora — product tour steps (docs/ui-redesign.md §6). Loaded with the tour.

   A step:
     targets  CSS selectors, first visible one wins; none visible → the step is
              shown centred instead of getting stuck.
     nav      the target lives in the sidebar: on a phone the drawer opens first.
     page     the module that must be showing (switched to if it isn't).
     click    a selector clicked before the step (e.g. a tab).
     title / body  strings, or functions of the run context:
              ({ isPhone, drawerNav, writeProtected, stations, target }).
   ═══════════════════════════════════════════════════════════════ */

const t = (id) => `[data-tour="${id}"]`;

export const MAIN_TOUR = [
  {
    targets: [t('station-switcher')],
    title: 'Choose a station',
    body: ({ stations }) => `${stations.join(' and ')}. Every page, chart and alert follows this switch, and so does the address bar, so a copied link opens the same view.`,
  },
  {
    targets: [t('status-strip')],
    title: 'Where the numbers come from',
    body: ({ isPhone }) => `Where the numbers come from right now: the live simulator, the server's own backup model, or a browser-only demo if the server is unreachable. Every value on every page also carries a label saying where it comes from.${isPhone ? ' Tap the dot for its name.' : ''}`,
  },
  {
    targets: [t('alert-centre')],
    title: 'Alerts',
    body: 'Open alerts by severity. Open the alert centre to acknowledge one, see what is already acknowledged, or browse the history.',
  },
  {
    targets: [t('assistant')],
    title: 'Ask Aurora',
    body: ({ isPhone }) => `Aurora is the station assistant. Ask in plain words ("What's the fuel situation at Maitri?") or give a command ("Open the energy grid"). It answers only from the station's data and says when the data doesn't have the answer. It asks before anything that changes what other visitors see, and walks you through an incident step by step. ${isPhone ? 'Tap the mic to talk' : 'Hold V or click the mic to talk'}, or type.`,
  },
  {
    targets: [t('operator-login')],
    title: ({ judge }) => (judge?.sandbox ? 'Your own sandbox' : 'Viewing is open; changing needs sign-in'),
    body: ({ writeProtected, judge }) => (judge?.sandbox
      ? 'Try everything: change a threshold, edit the inventory ledger, acknowledge an alert, request a command. Your changes are private to you and reset after an hour; nobody else sees them. The Aurora team changes the shared station with Team sign-in, in the ⋮ menu.'
      : writeProtected === true
        ? 'You can view everything. Sign in with the operator token to change thresholds, the inventory ledger, alerts or the simulator. Every change asks for confirmation first.'
        : 'Write protection is off on this server, so every control is enabled. On the public deployment, changes need the operator token, and every change asks for confirmation first.'),
  },
  {
    targets: [t('overview')],
    page: 'overview',
    title: 'The station twin',
    body: 'A simplified 3D view of the station. The sun follows the station\'s simulated time of day, the blowing snow follows the wind, and a building with an alert turns the alert\'s colour. Select a building for its readings; Antarctica (or the A key) shows both stations on the map.',
  },
  {
    targets: [t('nav-monitor')],
    nav: true,
    title: 'Monitor',
    body: 'Weather, infrastructure and the energy grid: the live state of the station.',
  },
  {
    targets: [t('nav-operate')],
    nav: true,
    title: 'Operate',
    body: 'The operator-entered inventory ledger, and remote commands. Commands are simulated: nothing reaches real equipment.',
  },
  {
    targets: [t('nav-analyse')],
    nav: true,
    title: 'Analyse',
    body: 'What-if scenarios, AI diagnostics and printable reports.',
  },
  {
    targets: [t('nav-ai')],
    nav: true,
    title: 'AI diagnostics',
    body: 'A machine-learning detector that spots readings far from what our model expects, a rule-based decision engine, and forecasts. Each result says which method produced it.',
  },
  {
    targets: [t('nav-twinInspector')],
    nav: true,
    title: 'Twin inspector',
    body: 'How each number is worked out, step by step from the weather to the power needed to the fuel burnt, with the assumptions behind it.',
  },
  {
    targets: [t('demo-control'), '[data-testid="topbar-more"]'],
    title: 'Demo control',
    body: ({ target, writeProtected, judge }) => `${target === '[data-testid="topbar-more"]' ? 'On a phone, Demo control is in this ⋮ menu. It' : 'Demo control'} injects a synthetic fault into the active station so you can watch an alert travel through the system. Injected values are labelled Simulated.${judge?.publicDemo ? ' Anyone can run one: it is shared with every visitor, one per station at a time, and resets itself after 2 minutes. "Try a demo" on the station card opens it too.' : writeProtected === true ? ' Operator sign-in required.' : ''}`,
  },
  {
    targets: [t('nav-system')],
    nav: true,
    title: 'System',
    body: ({ isPhone }) => `Data sources, alert thresholds and the station configuration. That's the tour. Restart it any time from ${isPhone ? 'the ⋮ menu' : 'Help (?)'} or the command palette.`,
  },
];

const PAGE_TOUR_STEPS = {
  environmental: [
    {
      targets: ['[data-testid="weather-kpis"]'],
      title: 'Live weather',
      body: 'The current weather at the station, with the recent trend. The label in the header says whether it is replayed past weather (ERA5) or a real station observation.',
    },
    {
      targets: ['[data-testid="weather-analysis"]'],
      title: 'Stored observations',
      body: 'A different source from the cards above: weather records stored in our database (NCPOR weather station and ERA5). These charts do not move with the live view.',
    },
    {
      targets: ['[data-testid="weather-analysis"] [role="tablist"]'],
      title: 'Analysis tools',
      body: 'Observations, anomaly scoring, a statistical forecast, correlations and a cold-exposure risk view. Each one names its method and the data it used.',
    },
    {
      targets: ['[data-testid="ncpor-freshness"]'],
      title: 'Real data from NCPOR',
      body: 'Real weather station readings from NCPOR\'s public website are fetched automatically every half hour. This line says when, and any reading that looks implausible is flagged instead of being used.',
    },
    {
      targets: ['[data-testid="ncpor-ingest"]'],
      title: 'Sync now',
      body: 'The Aurora team can also fetch the newest NCPOR data at once. It changes stored data, so it needs Team sign-in and asks for confirmation.',
    },
  ],
  infrastructure: [
    {
      targets: ['[data-testid="infra-kpis"]'],
      title: 'Station health at a glance',
      body: 'How many subsystems are normal, open alerts, cascade risks, and a rule-based health roll-up from the backend alert engine.',
    },
    {
      targets: ['[data-testid="building-grid"]'],
      title: 'Buildings',
      body: 'One tile per building with its key readings and status. Select one for its full panel.',
    },
    {
      targets: ['[data-testid="infra-dependency"]'],
      title: 'Reading the dependency graph',
      body: 'Columns run left to right from source to consumer: fuel store, generator, then the loads and the buildings they serve. Line style tells the relation apart (powers, fuels, heats, supplies). When the backend flags a cascade risk, that chain is drawn in its status colour. The graph comes from the station configuration.',
    },
  ],
  simulation: [
    {
      targets: ['[data-testid="whatif-scenarios"] [role="group"]'],
      title: '1. Pick a hazard',
      body: 'Each hazard is a set of rules applied to the station\'s current readings.',
    },
    {
      targets: ['[data-testid="whatif-intensity"]'],
      title: '2. Set the intensity',
      body: 'A multiplier on the hazard. ×1 is the rule\'s nominal case.',
    },
    {
      targets: ['[data-testid="whatif-run"]'],
      title: '3. Run it',
      body: 'Running it only reads the current readings and changes nothing, so it needs no sign-in.',
    },
    {
      targets: ['[data-testid="whatif-result"]', '[data-testid="whatif-placeholder"]'],
      title: '4. Read the cascade',
      body: 'Baseline against scenario for each quantity, the consequences, the subsystems affected, and the assumptions the rules make. It is rule-based, not a forecast.',
    },
  ],
  admin: [
    {
      targets: ['[data-testid="admin-tab-thresholds"]'],
      click: '[data-testid="admin-tab-thresholds"]',
      title: 'Alert thresholds',
      body: 'The limits every reading is checked against, every two seconds.',
    },
    {
      targets: ['[data-testid="thresholds-form"] thead'],
      title: 'Defaults and overrides',
      body: 'Defaults come from the station configuration file. A value you save becomes a per-station override, marked "Override" with a Reset button that returns it to the default.',
    },
    {
      targets: ['[data-testid="admin-save"]'],
      title: 'What saving does',
      body: ({ judge }) => (judge?.sandbox
        ? 'Saving asks for confirmation. Your own alerts use the new limits straight away; other visitors keep the station\'s limits.'
        : 'Saving needs operator sign-in, asks for confirmation and records your name. Alerts use the new limits within two seconds and clear after a few normal readings.'),
    },
  ],
};

export function tourSteps(kind) {
  return kind === 'main' ? MAIN_TOUR : PAGE_TOUR_STEPS[kind] || [];
}
