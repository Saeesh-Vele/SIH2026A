/* ═══════════════════════════════════════════════════════════════
   Aurora — the ONE top bar (v2: the status strip merged in).

     desktop  logo · station switcher | source · link · alerts · events ··· telemetry time · Aurora · search · help · demo · theme · Sign in
     tablet   ☰ logo · switcher | source · link · alerts · events (icons) ··· demo · theme · Sign in
     phone    ☰ switcher · source dot · alerts ··· Sign in · ⋮ (link, events, demo control, theme, telemetry time)

   "Sign in" is always visible, at every width. Hints are the lightweight shell
   tooltip (ui/Hint) so Popper stays out of the startup bundle; the phone overflow
   menu loads on first open.
   ═══════════════════════════════════════════════════════════════ */
import { lazy, Suspense, useState } from 'react';
import { AppBar, Box, ButtonBase, IconButton, Toolbar, Typography } from '@mui/material';
import { useColorScheme } from '@mui/material/styles';
import DarkModeOutlined from '@mui/icons-material/DarkModeOutlined';
import HistoryOutlined from '@mui/icons-material/HistoryOutlined';
import HelpOutlineOutlined from '@mui/icons-material/HelpOutlineOutlined';
import SearchOutlined from '@mui/icons-material/SearchOutlined';
import LightModeOutlined from '@mui/icons-material/LightModeOutlined';
import MenuOutlined from '@mui/icons-material/MenuOutlined';
import MicNoneOutlined from '@mui/icons-material/MicNoneOutlined';
import MoreVertOutlined from '@mui/icons-material/MoreVertOutlined';
import NotificationsOutlined from '@mui/icons-material/NotificationsOutlined';
import ScienceOutlined from '@mui/icons-material/ScienceOutlined';
import SensorsOutlined from '@mui/icons-material/SensorsOutlined';
import SensorsOffOutlined from '@mui/icons-material/SensorsOffOutlined';
import { useNow } from '../hooks/useNow';
import { useAdminToken } from '../hooks/useAdminToken';
import { formatRelative, formatTimeIST } from '../lib/format';
import Hint from '../ui/Hint';
import StatusDot from '../ui/StatusDot';
import OperatorLogin from '../components/OperatorLogin';
import StationSwitcher from './StationSwitcher';
import { dataSourceInfo } from './dataSource';

const TopBarMenu = lazy(() => import('./TopBarMenu'));
const HelpMenu = lazy(() => import('./HelpMenu'));

/** A compact status chip: tonal, 30 px tall; a button when it opens something. */
function BarChip({ children, onClick, sx, ...rest }) {
  return (
    <ButtonBase
      component={onClick ? 'button' : 'div'}
      onClick={onClick}
      disabled={!onClick}
      sx={[(theme) => ({
        height: 30,
        minWidth: 30,
        px: 2.5,
        gap: 1.5,
        borderRadius: '8px',
        flex: 'none',
        color: theme.vars.palette.text.secondary,
        backgroundColor: theme.vars.palette.aurora.surfaceRaised,
        fontSize: 13,
        fontWeight: 500,
        whiteSpace: 'nowrap',
        transition: theme.transitions.create(['background-color', 'color'], { duration: theme.transitions.duration.shortest }),
        '&.Mui-disabled': { color: theme.vars.palette.text.secondary },
        '&:hover': onClick ? { backgroundColor: theme.vars.palette.action.hover, color: theme.vars.palette.text.primary } : {},
        '& .MuiSvgIcon-root': { fontSize: 16 },
      }), ...(Array.isArray(sx) ? sx : [sx])]}
      {...rest}
    >
      {children}
    </ButtonBase>
  );
}

function useSchemeToggle() {
  const { mode, systemMode, setMode } = useColorScheme();
  const current = (mode === 'system' ? systemMode : mode) || 'dark';
  const next = current === 'dark' ? 'light' : 'dark';
  return { current, next, toggle: () => setMode(next) };
}

const hideBelow = (bp) => ({ display: { xs: 'none', [bp]: 'inline-flex' } });
const showBelow = (bp) => ({ display: { xs: 'inline-flex', [bp]: 'none' } });

export default function TopBar({
  activeStation, onStationChange, isDesktop, onOpenNav,
  telemetryBadge, isConnected, alertCount, criticalCount, updatedAt,
  onOpenLink, onOpenAlerts, onToggleTimeline, onOpenDemo, onOpenPalette, onOpenHelp, demoActive,
  onStartTour, pageTourLabel, onStartPageTour, signInOpen, onSignInOpenChange, onShare, onOpenAbout, onOpenWelcome, onOpenStories,
  onOpenAssistant, assistantOpen,
}) {
  const now = useNow(1000);
  const scheme = useSchemeToggle();
  const [menuAnchor, setMenuAnchor] = useState(null);
  const [menuLoaded, setMenuLoaded] = useState(false);
  const [helpAnchor, setHelpAnchor] = useState(null);
  const [helpLoaded, setHelpLoaded] = useState(false);
  const [sourceHint, setSourceHint] = useState(false);
  const { judge, loggedIn, writeProtected } = useAdminToken();
  // Judge mode: the ⋮ menu is at every width (it holds Team sign-in and Share this view).
  const menuEverywhere = judge.sandbox || judge.publicDemo;
  const teamSignIn = judge.sandbox && writeProtected === true && !loggedIn;

  const source = dataSourceInfo(telemetryBadge);
  const warningCount = alertCount - criticalCount;
  const alertStatus = criticalCount > 0 ? 'critical' : alertCount > 0 ? 'warning' : 'normal';
  const alertLabel = alertCount === 0
    ? 'No alerts'
    : [criticalCount && `${criticalCount} critical`, warningCount && `${warningCount} warning`].filter(Boolean).join(' · ');
  const telemetryTime = updatedAt != null ? `${formatTimeIST(updatedAt)} · ${formatRelative(updatedAt, now)}` : null;

  return (
    <AppBar position="static" className="topbar">
      <Toolbar disableGutters sx={{ px: { xs: 2, sm: 3, md: 4 }, gap: { xs: 1, sm: 2, md: 3 } }}>
        {!isDesktop && (
          <IconButton edge="start" onClick={onOpenNav} aria-label="Open navigation" sx={{ mr: { xs: 0, sm: 1 } }}>
            <MenuOutlined />
          </IconButton>
        )}
        <Box sx={{ alignItems: 'center', gap: 2, minWidth: 0, ...hideBelow('sm') }}>
          <Box component="img" src="/logo.jpeg" alt="" sx={{ width: 24, height: 24, borderRadius: '6px', flex: 'none' }} />
          <Typography component="span" sx={{ fontWeight: 600, fontSize: 15, letterSpacing: '0.01em', display: { sm: 'none', md: 'inline' } }}>Aurora</Typography>
        </Box>
        <StationSwitcher value={activeStation} onChange={onStationChange} />

        {/* ── Status chips ─────────────────────────────────── */}
        <Box role="region" aria-label="Station status" data-tour="status-strip"
          sx={{ display: 'flex', alignItems: 'center', gap: 1.5, minWidth: 0, ml: { sm: 1, md: 2 } }}>
          <Hint title={`${source.label}. ${source.help}`} pinned={sourceHint} onHide={() => setSourceHint(false)}>
            <BarChip data-testid="data-source-badge" data-source={telemetryBadge} aria-label={`Data source: ${source.label}`}
              onClick={() => setSourceHint((v) => !v)}
              sx={{ px: { xs: 0, md: 2.5 }, backgroundColor: { xs: 'transparent', md: undefined } }}>
              <StatusDot status={source.status} />
              <Box component="span" sx={{ display: { xs: 'none', md: 'inline' } }}>{source.label}</Box>
            </BarChip>
          </Hint>

          <Hint title="Satellite link details" sx={hideBelow('sm')}>
            <BarChip onClick={onOpenLink} className="status-pill connection"
              aria-label={`Satellite link: ${isConnected ? 'up' : 'down (simulated)'}`}
              sx={(theme) => ({ color: isConnected ? undefined : theme.vars.palette.status.offline })}>
              {isConnected ? <SensorsOutlined /> : <SensorsOffOutlined />}
              <Box component="span" sx={{ display: { xs: 'none', lg: 'inline' } }}>{isConnected ? 'Link up' : 'Link down'}</Box>
            </BarChip>
          </Hint>

          <Hint title="Open the alert centre">
            <BarChip onClick={onOpenAlerts} data-testid="alerts-pill" data-alert-count={alertCount} data-tour="alert-centre"
              aria-label={`Alerts: ${alertLabel}`}
              sx={(theme) => (alertCount > 0 ? {
                color: theme.vars.palette.status[alertStatus],
                backgroundColor: theme.vars.palette.status[`${alertStatus}Tint`],
                fontWeight: 600,
                '&:hover': { backgroundColor: theme.vars.palette.status[`${alertStatus}Tint`], color: theme.vars.palette.status[alertStatus] },
              } : {})}>
              <NotificationsOutlined />
              {alertCount > 0 && <Box component="span" sx={{ display: { xs: 'inline', md: 'none' } }}>{alertCount}</Box>}
              <Box component="span" sx={{ display: { xs: 'none', md: 'inline' } }}>{alertLabel}</Box>
            </BarChip>
          </Hint>

          <Hint title="Station event log" sx={hideBelow('sm')}>
            <BarChip onClick={onToggleTimeline} aria-label="Open the event log">
              <HistoryOutlined />
              <Box component="span" sx={{ display: { xs: 'none', lg: 'inline' } }}>Events</Box>
            </BarChip>
          </Hint>
        </Box>

        <Box sx={{ flex: 1, minWidth: 0 }} />

        {telemetryTime && (
          <Typography variant="body2" sx={{ color: 'text.secondary', whiteSpace: 'nowrap', flex: 'none', display: { xs: 'none', xl: 'block' } }}>
            Telemetry <Box component="span" sx={{ typography: 'mono', color: 'text.primary' }}>{formatTimeIST(updatedAt)}</Box> · {formatRelative(updatedAt, now)}
          </Typography>
        )}

        {/* Aurora assistant launcher: the panel itself is a lazy chunk. */}
        <Hint title="Ask Aurora: voice or text (hold V to talk)">
          <BarChip onClick={onOpenAssistant} aria-label="Ask Aurora, the assistant" aria-expanded={Boolean(assistantOpen)} data-testid="assistant-open" data-tour="assistant"
            sx={(theme) => ({ color: theme.vars.palette.primary.main, ...(assistantOpen ? { backgroundColor: theme.vars.palette.action.selected } : {}) })}>
            <MicNoneOutlined />
            <Box component="span" sx={{ display: { xs: 'none', lg: 'inline' } }}>Aurora</Box>
          </BarChip>
        </Hint>
        <Hint title="Search and commands (⌘K / Ctrl+K)" sx={hideBelow('sm')}>
          <BarChip onClick={onOpenPalette} aria-label="Open the command palette" data-testid="palette-open" data-tour="command-palette"
            sx={{ bgcolor: 'transparent', border: 1, borderColor: 'divider' }}>
            <SearchOutlined />
            <Box component="span" sx={{ display: { xs: 'none', lg: 'inline' } }}>Search</Box>
            <Box component="kbd" sx={{ display: { xs: 'none', lg: 'inline' }, fontFamily: 'inherit', fontSize: 12, color: 'text.secondary', ml: 1 }}>⌘K</Box>
          </BarChip>
        </Hint>
        <Hint title="Help: tour and keyboard shortcuts" sx={hideBelow('sm')}>
          <IconButton onClick={(e) => { setHelpLoaded(true); setHelpAnchor(e.currentTarget); }} aria-label="Help"
            aria-haspopup="menu" aria-expanded={helpAnchor ? 'true' : undefined} data-testid="help-open" data-tour="help">
            <HelpOutlineOutlined fontSize="small" />
          </IconButton>
        </Hint>
        {helpLoaded && (
          <Suspense fallback={null}>
            <HelpMenu anchorEl={helpAnchor} onClose={() => setHelpAnchor(null)} onStartTour={onStartTour}
              onOpenWelcome={onOpenWelcome} onOpenStories={onOpenStories} onOpenAbout={onOpenAbout}
              pageTourLabel={pageTourLabel} onStartPageTour={onStartPageTour} onOpenShortcuts={onOpenHelp} />
          </Suspense>
        )}
        <Hint title="Demo control: inject a synthetic fault" sx={hideBelow('sm')}>
          <IconButton onClick={onOpenDemo} data-tour="demo-control" aria-label={`Demo control${demoActive ? ' (scenario active)' : ''}`} data-testid="demo-control-open"
            sx={{ position: 'relative' }}>
            <ScienceOutlined fontSize="small" />
            {demoActive && <StatusDot status="simulated" size={7} sx={{ position: 'absolute', top: 6, right: 6 }} />}
          </IconButton>
        </Hint>
        <Hint title={`Switch to ${scheme.next} theme`} sx={hideBelow('sm')}>
          <IconButton onClick={scheme.toggle} aria-label={`Switch to ${scheme.next} theme`} data-testid="color-scheme-toggle">
            {scheme.current === 'dark' ? <LightModeOutlined fontSize="small" /> : <DarkModeOutlined fontSize="small" />}
          </IconButton>
        </Hint>

        <Box data-tour="operator-login" sx={{ flex: 'none', display: 'flex' }}><OperatorLogin dialogOpen={signInOpen} onDialogOpenChange={onSignInOpenChange} /></Box>

        {/* ── Phone overflow ───────────────────────────────── */}
        <IconButton
          aria-label="More"
          aria-haspopup="menu"
          aria-expanded={menuAnchor ? 'true' : undefined}
          data-testid="topbar-more"
          onClick={(e) => { setMenuLoaded(true); setMenuAnchor(e.currentTarget); }}
          sx={{ position: 'relative', ...(menuEverywhere ? {} : showBelow('sm')) }}
        >
          <MoreVertOutlined />
          {(demoActive || !isConnected) && <StatusDot status={demoActive ? 'simulated' : 'offline'} size={7} sx={{ position: 'absolute', top: 6, right: 6 }} />}
        </IconButton>
        {menuLoaded && (
          <Suspense fallback={null}>
            <TopBarMenu
              anchorEl={menuAnchor}
              onClose={() => setMenuAnchor(null)}
              isConnected={isConnected}
              demoActive={demoActive}
              scheme={scheme}
              telemetryTime={telemetryTime}
              sourceLabel={source.label}
              onOpenLink={onOpenLink}
              onToggleTimeline={onToggleTimeline}
              onOpenDemo={onOpenDemo}
              onOpenPalette={onOpenPalette}
              onOpenHelp={onOpenHelp}
              onStartTour={onStartTour}
              phoneOnly={menuEverywhere}
              onTeamSignIn={teamSignIn ? () => onSignInOpenChange?.(true) : null}
              onShare={onShare}
              onAbout={onOpenAbout}
              onStories={onOpenStories}
            />
          </Suspense>
        )}
      </Toolbar>
    </AppBar>
  );
}
