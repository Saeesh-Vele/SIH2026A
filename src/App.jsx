/* ═══════════════════════════════════════════════════════════════
   Aurora — Antarctic station digital twin.
   App shell (docs/ui-redesign.md §4): ONE top bar (station switcher, status
   chips, Sign in), sectioned sidebar with the station mini-card, and the main
   stage — the 3D overview or one module page. The page and station live in
   the URL (?module=&station=); ⌘K opens the command palette, "?" the
   shortcuts, "g" + a letter navigates. The product tour (src/tour) starts once
   on a first visit, after the first telemetry snapshot; Help restarts it.
   ═══════════════════════════════════════════════════════════════ */
import { useState, useCallback, useEffect, useMemo, useRef, lazy, Suspense } from 'react';
import { useMediaQuery } from '@mui/material';
import { useColorScheme, useTheme } from '@mui/material/styles';
import ErrorBoundary from './components/ErrorBoundary';
import PanelFallback from './components/PanelFallback';
import TopBar from './shell/TopBar';
import SideNav from './shell/SideNav';
import { MODULES, NAV_ACTIONS } from './shell/navigation';
import { initialUrlState, useUrlState } from './shell/urlState';
import { useShortcuts } from './shell/useShortcuts';
import { STATION_IDS, stationMeta } from './data/stationConfig';
import { useStationData } from './hooks/useStationData';
import { useDatabase } from './hooks/useDatabase';
import { useAdminToken } from './hooks/useAdminToken';
import { useToast } from './ui/feedbackContext';
import { askAurora, openAssistant, setAssistant, useAssistant } from './assistant/bus';
import { TourContext } from './tour/tourContext';
import { PAGE_TOURS, markTourSeen, readTourParam } from './tour/tourPrefs';
import { STORY_META, markWelcomeSeen, readStoryParam, welcomeSeen } from './tour/storyMeta';
import { apiPost } from './services/api';
import { trackModuleView, trackBuildingView, trackConnectionToggle, trackStationSwitch } from './services/analyticsService';
import './App.css';

// ── Code splitting ─────────────────────────────────────────
// Everything below is fetched only when it is first shown, which keeps three.js
// (the 3D twin), recharts (the charts), MUI's Modal-based drawers and dialogs and
// every page out of the initial bundle — startup JS stays under 500 kB.
const OverviewHUD = lazy(() => import('./components/OverviewHUD'));
const AlertCentre = lazy(() => import('./overlays/AlertCentre'));
const LinkDrawer = lazy(() => import('./overlays/LinkDrawer'));
const DemoControlDrawer = lazy(() => import('./overlays/DemoControlDrawer'));
const DemoBanner = lazy(() => import('./shell/DemoBanner'));
const LinkBanner = lazy(() => import('./shell/LinkBanner'));
const WelcomeDialog = lazy(() => import('./judge/WelcomeDialog'));
const AboutDialog = lazy(() => import('./judge/AboutDialog'));
const EventsDrawer = lazy(() => import('./overlays/EventsDrawer'));
const CommandPalette = lazy(() => import('./shell/CommandPalette'));
const ShortcutsDialog = lazy(() => import('./shell/ShortcutsDialog'));
const StationScene = lazy(() => import('./components/StationScene'));
const BuildingDrawer = lazy(() => import('./modules/infrastructure/BuildingDrawer'));
const TwinInspectorDialog = lazy(() => import('./modules/twin/TwinInspectorDialog'));
const AiModule = lazy(() => import('./modules/ai/AiModule'));
const WeatherModule = lazy(() => import('./modules/weather/WeatherModule'));
const WhatIfModule = lazy(() => import('./modules/whatif/WhatIfModule'));
const LogisticsModule = lazy(() => import('./modules/logistics/LogisticsModule'));
const RemoteModule = lazy(() => import('./modules/remote/RemoteModule'));
const AdminModule = lazy(() => import('./modules/admin/AdminModule'));
const ReportsModule = lazy(() => import('./modules/reports/ReportsModule'));
const InfrastructureModule = lazy(() => import('./modules/infrastructure/InfrastructureModule'));
const EnergyModule = lazy(() => import('./modules/energy/EnergyModule'));
// Aurora assistant: everything but the launcher and its tiny store (assistant/bus.js) loads here.
const AssistantHost = lazy(() => import('./assistant/AssistantHost'));

export default function App() {
  const theme = useTheme();
  const isDesktop = useMediaQuery(theme.breakpoints.up('md'), { noSsr: true });
  // From lg up the HUD floats over the 3D scene (bottom band), so the scene is drawn with a
  // lens shift that lifts the station clear of it; below lg the HUD sits under the scene.
  const hudOverlays = useMediaQuery(theme.breakpoints.up('lg'), { noSsr: true });
  const isPhone = useMediaQuery(theme.breakpoints.down('sm'), { noSsr: true });
  const [hudBand, setHudBand] = useState(0);   // px of HUD cards along the scene's bottom

  // ── State ──────────────────────────────────────────────────
  // Page and station start from the URL (refresh-safe, shareable) and stay in it.
  const [activeModule, setActiveModule] = useState(() => initialUrlState().module);
  const [activeStation, setActiveStation] = useState(() => initialUrlState().station);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [selectedBuilding, setSelectedBuilding] = useState(null);
  const [, setHoveredBuilding] = useState(null);   // hover is tracked by the scene; no consumer yet
  const [showTwinInspector, setShowTwinInspector] = useState(false);
  const [alertTab, setAlertTab] = useState({ tab: 'active', n: 0 });
  const [whatIfPreset, setWhatIfPreset] = useState(null);
  const assistantOpen = useAssistant((s) => s.open);
  // Drawers and dialogs: mounted on first open (their chunks load then) and kept mounted
  // so their close transition still runs. `open` is the one that is showing.
  const [open, setOpen] = useState(null);       // 'alerts' | 'link' | 'events' | 'demo' | 'palette' | 'help'
  const [mounted, setMounted] = useState({});
  const show = useCallback((id) => { setMounted((m) => (m[id] ? m : { ...m, [id]: true })); setOpen(id); }, []);
  const close = useCallback(() => setOpen(null), []);
  const openAlerts = useCallback(() => show('alerts'), [show]);
  const openLink = useCallback(() => show('link'), [show]);
  const { mode, systemMode, setMode } = useColorScheme();
  const scheme = (mode === 'system' ? systemMode : mode) || 'dark';
  const { loggedIn, writeProtected, logout, judge, canWriteShared } = useAdminToken();
  const [signInOpen, setSignInOpen] = useState(false);
  const toast = useToast();

  // ── Live data (station-aware) ─────────────────────────────
  const { stationData, dataSource, toggleConnection, acknowledgeAlert } = useStationData(activeStation);

  // ── Database persistence ──────────────────────────────────
  useDatabase(activeStation, stationData);

  // ── Derived state ────────────────────────────────────────
  // Backend alerts (or browser-demo alerts, computed in useStationData) — no extra client rules.
  const activeAlerts = stationData.activeAlerts || [];
  const criticalCount = activeAlerts.filter(a => a.level === 'critical').length;
  const isConnected = stationData.connected !== undefined ? stationData.connected : true;
  // Global data-source status: live simulator / physics fallback / browser demo / offline
  const telemetryBadge = !isConnected
    ? 'offline'
    : dataSource === 'simulation'
      ? 'browser-demo'
      : dataSource === 'websocket'
        ? (stationData.telemetrySource || 'connecting')
        : 'connecting';
  const aiHealth = stationData.aiHealth || 'healthy';
  const dependencyAlerts = stationData.dependencyAlerts || [];
  const eventTimeline = stationData.eventTimeline || [];
  const updatedAt = telemetryBadge === 'connecting' ? null : stationData.timestamp;
  const demoActive = Boolean(stationData.provenance?.activeScenario || stationData.publicDemo?.[activeStation]);
  const anyDemoRunning = Object.keys(stationData.publicDemo || {}).length > 0;

  // ── Product tour ──────────────────────────────────────────
  // driver.js loads on first start. The run context reads live values through refs,
  // because a tour outlives the render that started it.
  const [tourActive, setTourActive] = useState(false);
  const tourParam = useState(readTourParam)[0];
  const tourStop = useRef(null);
  const live = useRef({});
  useEffect(() => { live.current = { activeModule, isDesktop, isPhone, scheme, writeProtected, judge, stationData, activeStation, selectedBuilding }; });
  // The guided story being played: which one, whether it joined another visitor's
  // scenario, and whether it started one itself (which it then resets).
  const storyRun = useRef(null);
  const startTour = useCallback((kind = 'main') => {
    if (tourStop.current) return;
    // Focus goes back here when the tour ends (captured now: the opener may be a menu
    // item that unmounts, in which case the page's main region takes it).
    const opener = document.activeElement;
    setOpen(null);
    setSelectedBuilding(null);
    setShowTwinInspector(false);
    if (kind === 'main') markTourSeen('started');
    setTourActive(true);
    tourStop.current = () => {};
    const story = kind.startsWith('story:') ? kind.slice(6) : null;
    Promise.all([import('./tour/runTour'), story ? import('./tour/storyRuntime') : null]).then(([{ runTour }, runtime]) => {
      const l = live.current;
      tourStop.current = runTour(kind, {
        drawerNav: !l.isDesktop,
        isPhone: l.isPhone,
        scheme: l.scheme,
        writeProtected: l.writeProtected,
        judge: l.judge,
        stations: STATION_IDS.map((sid) => stationMeta(sid).name),
        returnFocus: opener,
        getModule: () => live.current.activeModule,
        goTo: (id) => { setActiveModule(id); setSelectedBuilding(null); },
        getStation: () => live.current.activeStation,
        setStation: (sid) => { trackStationSwitch(live.current.activeStation, sid); setActiveStation(sid); },
        setNavOpen: setMobileNavOpen,
        story: runtime ? runtime.storyHelpers(story, {
          live: () => live.current, run: () => storyRun.current, setSelectedBuilding, closeAll: () => setOpen(null),
        }) : undefined,
        onStoryError: (err) => {
          toast({ severity: 'info', text: err?.storyMessage || 'The story stopped: a step could not be shown. Try again, or pick another story.' });
          if (err?.storyMessage) show('stories');
        },
        onEnd: (outcome) => {
          tourStop.current = null;
          setTourActive(false);
          if (kind === 'main') markTourSeen(outcome);
          // A story that started a scenario and was left early resets it (the last step already did otherwise).
          const run = storyRun.current;
          if (run?.injected && outcome !== 'completed') {
            apiPost(`/sim/reset?stationId=${STORY_META[run.id].station}`).catch((err) => console.warn('[story] reset on exit failed', err));
          }
          storyRun.current = null;
        },
      });
    }).catch((err) => {
      console.error('[tour] could not load', err);
      tourStop.current = null;
      setTourActive(false);
      toast({ severity: 'error', text: 'The tour could not load. Check the connection and try again from Help.' });
    });
  }, [toast, show]);
  useEffect(() => () => tourStop.current?.(), []);

  // ── Guided stories (judge mode) ───────────────────────────
  // Scenario stories share their station's public demo slot (storyRuntime.js decides).
  const canRunScenarios = Boolean(judge.publicDemo || canWriteShared);
  const startStory = useCallback((id) => {
    if (!STORY_META[id] || tourStop.current) return;
    import('./tour/storyRuntime').then(({ storyAvailability }) => {
      const a = storyAvailability(live.current.stationData, canRunScenarios)[id];
      if (!a.ok) { show('stories'); toast({ severity: 'info', text: a.note }); return; }
      storyRun.current = { id, joined: Boolean(a.joins), injected: false };
      setOpen(null);
      startTour(`story:${id}`);
    }).catch((err) => {
      console.error('[story] could not load', err);
      toast({ severity: 'error', text: 'The story could not load. Check the connection and try again from Help.' });
    });
  }, [canRunScenarios, show, toast, startTour]);

  // First visit: the welcome card (its "Take the tour" starts the tour). ?tour=start
  // starts the tour, ?story= a story, ?tour=off shows neither. After the first telemetry.
  const storyParam = useState(readStoryParam)[0];
  const autoStarted = useRef(false);
  useEffect(() => {
    if (autoStarted.current || updatedAt == null || open || tourParam === 'off') return undefined;
    const id = setTimeout(() => {
      autoStarted.current = true;
      if (tourParam === 'start') startTour('main');
      else if (storyParam) { markWelcomeSeen('story-link'); startStory(storyParam); }
      else if (!welcomeSeen()) show('welcome');
    }, 700);
    return () => clearTimeout(id);
  }, [updatedAt, open, tourParam, storyParam, startTour, startStory, show]);

  const chooseWelcome = useCallback((choice) => {
    markWelcomeSeen(choice);
    setOpen(null);
    if (choice === 'tour') startTour('main');
    if (choice === 'aurora') openAssistant();
  }, [startTour]);
  const pageTour = PAGE_TOURS[activeModule] ? activeModule : null;
  const tourValue = useMemo(() => ({ start: startTour, active: tourActive }), [startTour, tourActive]);

  // ── Handlers ──────────────────────────────────────────────
  const handleBuildingClick = useCallback((buildingId) => {
    setSelectedBuilding(prev => {
      const next = prev === buildingId ? null : buildingId;
      if (next) trackBuildingView(next, activeStation);
      return next;
    });
  }, [activeStation]);

  // Open (not toggle) a building's panel: Infrastructure tiles, dependency map, panel chips.
  const openBuilding = useCallback((buildingId) => {
    setSelectedBuilding(buildingId);
    if (buildingId) trackBuildingView(buildingId, activeStation);
  }, [activeStation]);

  const handleBuildingHover = useCallback((buildingId) => {
    setHoveredBuilding(buildingId);
  }, []);

  const handleModuleChange = useCallback((moduleId) => {
    setActiveModule(moduleId);
    setSelectedBuilding(null);
    trackModuleView(moduleId, activeStation);
  }, [activeStation]);

  // Back / forward restore the page and station from the URL.
  useUrlState(activeModule, activeStation, (next) => {
    setActiveModule(next.module);
    setActiveStation(next.station);
    setSelectedBuilding(null);
  });

  const handleNavAction = useCallback((action) => {
    if (action === 'twinInspector') setShowTwinInspector(true);
  }, []);

  const handleStationChange = useCallback((newStation) => {
    trackStationSwitch(activeStation, newStation);
    setActiveStation(newStation);
  }, [activeStation]);

  const handleToggleConnection = useCallback(() => {
    trackConnectionToggle(!isConnected);
    return toggleConnection();
  }, [toggleConnection, isConnected]);

  // Simulated satellite link (store-and-forward): when a station's buffered readings have
  // just synced, everyone viewing it gets the summary ("Link restored: 142 readings …").
  const link = stationData.link;
  const linkDown = dataSource === 'websocket' && link && !link.up;
  const lastSync = link?.lastSync;
  const seenSync = useRef(undefined);
  useEffect(() => {
    if (!lastSync?.at || seenSync.current === lastSync.at) return;
    const first = seenSync.current === undefined;
    seenSync.current = lastSync.at;
    if (first && Date.now() - lastSync.at > 20000) return;      // an old sync, not news
    toast({ text: lastSync.message });
  }, [lastSync, toast]);

  // "Share this view": the URL already carries ?module=&station= (useUrlState).
  const shareView = useCallback(async () => {
    const url = window.location.href;
    try {
      await navigator.clipboard.writeText(url);
      toast({ text: 'Link copied: it opens this page and station.' });
    } catch (err) {
      console.warn('[share] clipboard unavailable', err);
      toast({ text: `Copy this link: ${url}` });
    }
  }, [toast]);

  const handleAlertClick = useCallback((buildingId) => {
    setSelectedBuilding(buildingId);
  }, []);

  // ── Aurora assistant: what its action layer may do (assistant/AssistantHost.jsx) ──
  // The host validates every action against the whitelist first; these are the same
  // setters the sidebar, switcher and drawers use, so nothing bypasses the normal UI.
  const assistantControls = useMemo(() => ({
    get: () => ({ module: live.current.activeModule, station: live.current.activeStation, building: live.current.selectedBuilding }),
    navigate: (id) => { if (MODULES[id]) handleModuleChange(id); },
    setStation: (sid) => { if (STATION_IDS.includes(sid) && sid !== live.current.activeStation) handleStationChange(sid); },
    openBuilding: (id) => openBuilding(id || null),
    openAlerts: (tab) => { setAlertTab((t) => ({ tab, n: t.n + 1 })); show('alerts'); },
    closeOverlay: () => setOpen(null),
    whatIf: (preset) => setWhatIfPreset(preset),
    startStory: (id) => startStory(id),
    scrollTo: (testId) => setTimeout(() => {
      document.querySelector(`[data-testid="${testId}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 450),
  }), [handleModuleChange, handleStationChange, openBuilding, show, startStory]);

  // ── Command palette + shortcuts ───────────────────────────
  const commands = useMemo(() => [
    ...Object.entries(MODULES).map(([id, m]) => ({
      id: `go-${id}`, group: 'Pages', label: `Go to ${m.label}`, keys: ['g', m.key], keywords: m.description, run: () => handleModuleChange(id),
    })),
    { id: 'twin', group: 'Pages', label: 'Open the Twin inspector', keys: ['g', NAV_ACTIONS.twinInspector.key], keywords: 'causal chain assumptions replay', run: () => setShowTwinInspector(true) },
    ...STATION_IDS.map((sid) => ({
      id: `station-${sid}`, group: 'Station', label: `Switch to ${stationMeta(sid).name}`, keywords: stationMeta(sid).region, run: () => handleStationChange(sid),
    })),
    { id: 'aurora', group: 'Aurora', label: 'Ask Aurora (the assistant)', keys: ['V'], keywords: 'assistant voice talk speak chat question mic incident help', run: () => openAssistant() },
    { id: 'alerts', group: 'Panels', label: 'Open the alert centre', keywords: 'alarms acknowledge history', run: openAlerts },
    { id: 'link', group: 'Panels', label: 'Satellite link details', keywords: 'connection source telemetry link loss', run: openLink },
    { id: 'events', group: 'Panels', label: 'Open the event log', keywords: 'timeline', run: () => show('events') },
    { id: 'demo', group: 'Panels', label: 'Open demo control', keywords: 'inject scenario fault', run: () => show('demo') },
    { id: 'theme', group: 'Settings', label: `Switch to ${scheme === 'dark' ? 'light' : 'dark'} theme`, keywords: 'colour color mode', run: () => setMode(scheme === 'dark' ? 'light' : 'dark') },
    ...(writeProtected !== true ? [] : loggedIn
      ? [{ id: 'signout', group: 'Settings', label: 'Sign out', keywords: 'logout operator token', run: () => { logout(); toast({ severity: 'info', text: 'Signed out. Aurora is read-only again.' }); } }]
      : [{ id: 'signin', group: 'Settings', label: 'Sign in as operator', keywords: 'login token write', run: () => setSignInOpen(true) }]),
    { id: 'tour', group: 'Help', label: 'Start tour', keywords: 'guide introduction walkthrough help', run: () => startTour('main') },
    { id: 'stories', group: 'Help', label: 'Play a guided story', keywords: 'scenario blizzard generator fuel demo story', run: () => show('stories') },
    { id: 'welcome', group: 'Help', label: 'Show the welcome card', keywords: 'welcome introduction start', run: () => show('welcome') },
    { id: 'about', group: 'Help', label: 'About Aurora', keywords: 'about team problem statement provenance github', run: () => show('about') },
    ...(pageTour ? [{ id: 'page-tour', group: 'Help', label: `Tour this page (${PAGE_TOURS[pageTour]})`, keywords: 'guide help', run: () => startTour(pageTour) }] : []),
    { id: 'help', group: 'Help', label: 'Keyboard shortcuts', keys: ['?'], run: () => show('help') },
  ], [handleModuleChange, handleStationChange, openAlerts, openLink, show, scheme, setMode, writeProtected, loggedIn, logout, toast, startTour, pageTour]);

  useShortcuts({
    onPalette: () => show('palette'),
    onHelp: () => show('help'),
    onTalk: (down) => setAssistant({ ptt: down, ...(down ? { open: true } : {}) }),
    onGo: (key) => {
      if (key === NAV_ACTIONS.twinInspector.key) { setShowTwinInspector(true); return true; }
      const id = Object.keys(MODULES).find((m) => MODULES[m].key === key);
      if (id) handleModuleChange(id);
      return Boolean(id);
    },
  });

  // ── Render module panel ───────────────────────────────────
  const panelName = `${MODULES[activeModule]?.title ?? 'Module'} panel`;

  function renderModulePanelInner() {
    switch (activeModule) {
      case 'environmental':
        return (
          <WeatherModule
            sensorData={stationData.sensors}
            activeStation={activeStation}
            provenance={stationData.provenance}
            telemetrySource={telemetryBadge}
            timestamp={stationData.timestamp}
            replay={stationData.replay}
            updatedAt={updatedAt}
            activeAlerts={activeAlerts}
          />
        );
      case 'infrastructure':
        return (
          <InfrastructureModule
            sensorData={stationData.sensors}
            alerts={stationData.alerts}
            activeAlerts={activeAlerts}
            onOpenBuilding={openBuilding}
            dependencyAlerts={dependencyAlerts}
            aiHealth={aiHealth}
            provenance={stationData.provenance}
            telemetrySource={telemetryBadge}
            activeStation={activeStation}
            updatedAt={updatedAt}
          />
        );
      case 'energy':
        return (
          <EnergyModule
            sensorData={stationData.sensors}
            energy={stationData.energy}
            replay={stationData.replay}
            provenance={stationData.provenance}
            activeAlerts={activeAlerts}
            activeStation={activeStation}
            telemetrySource={telemetryBadge}
            timestamp={stationData.timestamp}
            updatedAt={updatedAt}
          />
        );
      case 'logistics':
        return <LogisticsModule activeStation={activeStation} />;
      case 'simulation':
        return (
          <WhatIfModule activeStation={activeStation} sensorData={stationData.sensors}
            telemetrySource={telemetryBadge} updatedAt={updatedAt} preset={whatIfPreset} />
        );
      case 'reports':
        return (
          <ReportsModule activeStation={activeStation} sensorData={stationData.sensors}
            provenance={stationData.provenance} telemetrySource={telemetryBadge} timestamp={stationData.timestamp} />
        );
      case 'remote':
        return (
          <RemoteModule
            activeStation={activeStation}
            activeAlerts={activeAlerts}
            canAcknowledge={dataSource === 'websocket'}
            onAcknowledgeAlert={acknowledgeAlert}
            updatedAt={updatedAt}
          />
        );
      case 'admin':
        return <AdminModule activeStation={activeStation} />;
      case 'ai':
        return <AiModule activeStation={activeStation} updatedAt={updatedAt} />;
      default:
        return null;
    }
  }

  // One module page at a time. The wrapper is keyed by module, so switching unmounts
  // the previous panel outright (audit F1: with AnimatePresence around lazy panels the
  // exiting ones never unmounted and every visited module stayed on screen).
  // Each page has its own ErrorBoundary so one crash never blanks the app.
  function renderModulePage() {
    // Focusable so the page scrolls from the keyboard even when every control on it is
    // disabled (signed out): axe scrollable-region-focusable.
    return (
      <div key={activeModule} className="module-content-scroll" data-testid="module-panel" data-module={activeModule}
        tabIndex={0} role="region" aria-label={MODULES[activeModule]?.title}>
        <div className="module-page">
          <ErrorBoundary name={panelName} resetKey={activeStation}>
            <Suspense fallback={<PanelFallback name={panelName} />}>
              {renderModulePanelInner()}
            </Suspense>
          </ErrorBoundary>
        </div>
      </div>
    );
  }

  return (
    <TourContext.Provider value={tourValue}>
    <div className="aurora-app" data-tour-active={tourActive || undefined} data-link-down={linkDown || undefined}
      data-assistant-open={assistantOpen || undefined}>
      {/* First Tab stop: past the top bar and sidebar (about 25 stops) to the page. */}
      <a className="skip-link" href="#main">Skip to content</a>
      <TopBar
        activeStation={activeStation}
        onStationChange={handleStationChange}
        isDesktop={isDesktop}
        onOpenNav={() => setMobileNavOpen(true)}
        telemetryBadge={telemetryBadge}
        isConnected={isConnected}
        alertCount={activeAlerts.length}
        criticalCount={criticalCount}
        updatedAt={updatedAt}
        onOpenLink={openLink}
        onOpenAlerts={openAlerts}
        onToggleTimeline={() => show('events')}
        onOpenDemo={() => show('demo')}
        onOpenPalette={() => show('palette')}
        onOpenHelp={() => show('help')}
        onStartTour={() => startTour('main')}
        pageTourLabel={pageTour ? PAGE_TOURS[pageTour] : null}
        onStartPageTour={() => pageTour && startTour(pageTour)}
        signInOpen={signInOpen}
        onSignInOpenChange={setSignInOpen}
        demoActive={demoActive}
        onShare={shareView}
        onOpenAbout={() => show('about')}
        onOpenWelcome={() => show('welcome')}
        onOpenStories={() => show('stories')}
        onOpenAssistant={() => openAssistant()}
        assistantOpen={assistantOpen}
      />

      <div className="demo-banner-slot">
        {linkDown && (
          <Suspense fallback={null}>
            <LinkBanner link={link} activeStation={activeStation} onOpenLink={openLink} />
          </Suspense>
        )}
        {anyDemoRunning && (
          <Suspense fallback={null}>
            <DemoBanner publicDemo={stationData.publicDemo} receivedAt={stationData.receivedAt} activeStation={activeStation}
              onOpenDemo={() => show('demo')} onStationChange={handleStationChange} />
          </Suspense>
        )}
      </div>

      <div className="app-layout-body">
        <SideNav
          isDesktop={isDesktop}
          mobileOpen={mobileNavOpen}
          onMobileClose={() => setMobileNavOpen(false)}
          activeModule={activeModule}
          onSelect={handleModuleChange}
          onAction={handleNavAction}
          collapsed={isSidebarCollapsed}
          onToggleCollapse={() => setIsSidebarCollapsed(prev => !prev)}
          activeStation={activeStation}
          onStationChange={handleStationChange}
          replayMs={stationData.replay?.timeMs ?? null}
          tourActive={tourActive}
        />

        <main className="main-stage" id="main" tabIndex={-1}>
          <div id="aurora-highlight-slot" className="highlight-slot" />
          {activeModule === 'overview' ? (
            // The 3D overview and the HUD over it stay dark in both schemes (decision, §9).
            <div className="overview-stage" data-tour="overview" data-color-scheme="dark">
              {/* 3D twin: realistic station scenes + Antarctica view (Phase 2) */}
              <div className="scene-container">
                <ErrorBoundary name="3D station view">
                  <Suspense fallback={<PanelFallback name="3D station view" />}>
                    <StationScene
                      activeStation={activeStation}
                      avoidBottom={hudOverlays ? hudBand : 0}
                      alertStates={stationData.alerts}
                      selectedBuilding={selectedBuilding}
                      onBuildingClick={handleBuildingClick}
                      onBuildingHover={handleBuildingHover}
                      onStationChange={handleStationChange}
                      sensors={stationData.sensors}
                      replay={stationData.replay}
                    />
                  </Suspense>
                </ErrorBoundary>
              </div>

              <ErrorBoundary name="Overview HUD">
                <Suspense fallback={null}>
                  <OverviewHUD
                    sensorData={stationData.sensors}
                    alerts={stationData.alerts}
                    activeAlerts={activeAlerts}
                    activeStation={activeStation}
                    timestamp={stationData.timestamp}
                    telemetrySource={telemetryBadge}
                    provenance={stationData.provenance}
                    replay={stationData.replay}
                    onOverlayBand={setHudBand}
                    onOpenTwinInspector={() => setShowTwinInspector(true)}
                    onOpenDemo={() => show('demo')}
                  />
                </Suspense>
              </ErrorBoundary>
            </div>
          ) : renderModulePage()}
        </main>
      </div>

      {/* Building panel (design system; follows the active colour scheme). */}
      {selectedBuilding && (
        <ErrorBoundary name="Building panel" resetKey={selectedBuilding}>
          <Suspense fallback={null}>
            <BuildingDrawer
              buildingId={selectedBuilding}
              activeStation={activeStation}
              sensors={stationData.sensors}
              alerts={stationData.alerts}
              activeAlerts={activeAlerts}
              provenance={stationData.provenance}
              timestamp={stationData.timestamp}
              replay={stationData.replay}
              telemetrySource={telemetryBadge}
              onClose={() => setSelectedBuilding(null)}
              onOpenBuilding={openBuilding}
            />
          </Suspense>
        </ErrorBoundary>
      )}

      {/* Twin inspector (design system) — mounted once first opened. */}
      {showTwinInspector && (
        <ErrorBoundary name="Twin inspector">
          <Suspense fallback={null}>
            <TwinInspectorDialog activeStation={activeStation} isOpen={showTwinInspector}
              onClose={() => setShowTwinInspector(false)} replay={stationData.replay} />
          </Suspense>
        </ErrorBoundary>
      )}

      {/* ── Drawers and dialogs (mounted on first open) ── */}
      <Suspense fallback={null}>
        {mounted.alerts && (
          <AlertCentre key={alertTab.n} initialTab={alertTab.tab} open={open === 'alerts'} onClose={close} alerts={activeAlerts} onAlertClick={handleAlertClick}
            onAcknowledge={acknowledgeAlert} activeStation={activeStation} canAcknowledge={dataSource === 'websocket'} />
        )}
        {mounted.link && (
          <LinkDrawer open={open === 'link'} onClose={close} link={link} onToggleConnection={handleToggleConnection}
            telemetryBadge={telemetryBadge} provenance={stationData.provenance} activeStation={activeStation}
            onOpenDemo={() => show('demo')} />
        )}
        {(mounted.welcome || mounted.stories) && (
          <WelcomeDialog open={open === 'welcome' || open === 'stories'} view={open === 'stories' ? 'stories' : 'welcome'}
            onView={(v) => show(v)} onClose={(why) => { if (open === 'welcome') markWelcomeSeen(why); close(); }}
            onChoose={chooseWelcome} onPlayStory={(id) => { markWelcomeSeen('story'); startStory(id); }}
            onAbout={() => show('about')} stationData={stationData} canRunScenarios={canRunScenarios} />
        )}
        {mounted.about && <AboutDialog open={open === 'about'} onClose={close} />}
        {mounted.events && <EventsDrawer open={open === 'events'} onClose={close} events={eventTimeline} />}
        {mounted.demo && <DemoControlDrawer open={open === 'demo'} onClose={close} activeStation={activeStation}
          publicDemo={stationData.publicDemo} receivedAt={stationData.receivedAt} />}
        {mounted.palette && <CommandPalette open={open === 'palette'} onClose={close} commands={commands} onAsk={askAurora} />}
        {mounted.help && <ShortcutsDialog open={open === 'help'} onClose={close} onStartTour={() => startTour('main')} />}
      </Suspense>

      {/* Aurora assistant: loads after the first snapshot (or when first opened). */}
      {(updatedAt != null || assistantOpen) && (
        <ErrorBoundary name="Aurora assistant">
          <Suspense fallback={null}>
            <AssistantHost stationData={stationData} activeStation={activeStation} activeModule={activeModule}
              controls={assistantControls} canRunScenarios={canRunScenarios} tourActive={tourActive} isPhone={isPhone}
              writeProtected={writeProtected} />
          </Suspense>
        </ErrorBoundary>
      )}
    </div>
    </TourContext.Provider>
  );
}
