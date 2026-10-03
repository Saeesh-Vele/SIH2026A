/* ═══════════════════════════════════════════════════════════════
   Aurora — Overview HUD over the 3D twin (design system, dark in both modes).

   - Station card: name, coordinates, region and station facts from
     station_config.json; the Twin Inspector and Ask Aurora (the assistant).
   - KPI bento: outside temperature as the hero (30-min sparkline, delta vs
     15 min ago, wind chill), then wind, generation and subsystem status.
     Values are live telemetry; history is the backend's rolling window.

   From lg up the HUD floats over the scene and stays dark (it sits on the dark
   3D twin); below lg it sits in normal flow under a fixed-height scene (App.css)
   and follows the active colour scheme, like any page.
   ═══════════════════════════════════════════════════════════════ */
import { useEffect, useRef } from 'react';
import { Box, Button, Card, Stack, Typography, useMediaQuery } from '@mui/material';
import { useColorScheme, useTheme } from '@mui/material/styles';
import ArrowForwardOutlined from '@mui/icons-material/ArrowForwardOutlined';
import MicNoneOutlined from '@mui/icons-material/MicNoneOutlined';
import ScienceOutlined from '@mui/icons-material/ScienceOutlined';
import PlaceOutlined from '@mui/icons-material/PlaceOutlined';
import ViewInArOutlined from '@mui/icons-material/ViewInArOutlined';
import { openAssistant } from '../assistant/bus';
import { crewLabel, formatCoords, stationMeta } from '../data/stationConfig';
import { useSeries, valueAgo } from '../hooks/useSeries';
import { onModelClock } from '../lib/modelClock';
import { formatNumber, formatValue, isNum } from '../lib/format';
import { windChill } from '../lib/windChill';
import FadeValue from '../ui/FadeValue';
import KpiCard from '../ui/KpiCard';
import Sparkline from '../ui/Sparkline';
import StatusDot from '../ui/StatusDot';
import { STATUS_LABEL } from '../ui/statusLabels';
import { PROVENANCE } from '../ui/Provenance';

const SERIES_KEYS = ['lab.env_temp', 'lab.env_wind', 'generator.gen_power'];

function levelOf(activeAlerts, sensor) {
  const levels = activeAlerts.filter((a) => a.sensor === sensor).map((a) => a.level);
  return levels.includes('critical') ? 'critical' : levels.includes('warning') ? 'warning' : undefined;
}

/** Compact HUD figure: label, value, mini sparkline (a row on phones). */
function HudFigure({ label, value, unit, decimals = 0, points, bucketMs, footer, status, testId }) {
  const text = formatNumber(value, decimals);
  return (
    <Card component="section" aria-label={label} data-testid={testId} data-kpi="" sx={(theme) => ({
      p: { xs: 4, lg: 3.5 }, minWidth: 0, boxShadow: { lg: theme.vars.palette.aurora.shadowFloat },
      display: 'grid', gap: 2, alignItems: 'center',
      gridTemplateColumns: { xs: 'minmax(0, 1fr) minmax(0, 0.9fr)', lg: '1fr' },
    })}>
      <Box sx={{ minWidth: 0 }}>
        <Stack direction="row" sx={{ alignItems: 'center', gap: 1.5 }}>
          <Typography variant="label" component="h3" sx={{ color: 'text.secondary' }}>{label}</Typography>
          {status && <StatusDot status={status} size={7} />}
          {status && <Box component="span" sx={(theme) => ({ fontSize: 12, fontWeight: 600, color: theme.vars.palette.status[status] })}>{STATUS_LABEL[status]}</Box>}
        </Stack>
        <Stack direction="row" sx={{ alignItems: 'baseline', gap: 1, mt: 1 }}>
          <Typography variant="kpi" component="p" className="kpi-value" sx={{ m: 0, fontSize: 26, lineHeight: '32px' }}><FadeValue>{text}</FadeValue></Typography>
          {unit && isNum(value) && <Typography component="span" sx={{ color: 'text.secondary', fontSize: 13, fontWeight: 500 }}>{unit}</Typography>}
        </Stack>
      </Box>
      <Box sx={{ minWidth: 0 }}>{footer ?? <Sparkline points={points} height={24} bucketMs={bucketMs} />}</Box>
    </Card>
  );
}

function SubsystemDots({ alerts }) {
  const entries = Object.entries(alerts).filter(([k]) => k !== 'overall');
  return (
    <Stack direction="row" aria-hidden="true" sx={{ gap: 1, flexWrap: 'wrap', alignItems: 'center', minHeight: 28 }}>
      {entries.map(([k, level]) => <StatusDot key={k} status={level === 'critical' || level === 'warning' ? level : 'normal'} size={9} />)}
    </Stack>
  );
}

export default function OverviewHUD({
  sensorData,
  alerts = {},
  activeAlerts = [],
  activeStation,
  timestamp,
  telemetrySource,
  replay,
  provenance,
  onOverlayBand,
  onOpenTwinInspector,
  onOpenDemo,
}) {
  const theme = useTheme();
  const overlays = useMediaQuery(theme.breakpoints.up('lg'), { noSsr: true });
  const { mode, systemMode } = useColorScheme();
  const scheme = overlays ? 'dark' : ((mode === 'system' ? systemMode : mode) || 'dark');
  // Report how tall the band of overlay cards is (from the scene's bottom edge up to the
  // highest card), so the scene can fit the station above it.
  const rootRef = useRef(null);
  useEffect(() => {
    const root = rootRef.current;
    if (!root || !onOverlayBand) return undefined;
    const measure = () => {
      if (!overlays) { onOverlayBand(0); return; }
      const bottom = root.getBoundingClientRect().bottom;
      const tops = [...root.querySelectorAll('[data-testid=hud-station-card], [data-testid=hud-kpis]')].map((e) => e.getBoundingClientRect().top);
      onOverlayBand(tops.length ? Math.round(bottom - Math.min(...tops)) : 0);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(root);
    root.querySelectorAll(':scope > *').forEach((e) => ro.observe(e));
    return () => ro.disconnect();
  }, [overlays, onOverlayBand]);
  const station = stationMeta(activeStation);
  const envData = sensorData?.lab || {};
  const genData = sensorData?.generator || {};

  // Live telemetry only — missing values render as "—" (no hardcoded stand-ins).
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const temp = num(envData.env_temp);
  const wind = num(envData.env_wind);
  const power = num(genData.gen_power);
  const replayMs = num(replay?.timeMs);
  const raw = useSeries({ station: activeStation, keys: SERIES_KEYS, minutes: 30, sensors: sensorData, timestamp, source: telemetrySource, replayMs });
  // Trends on the model's clock (ERA5 replay time when replaying, else wall clock).
  const { clock, series } = onModelClock(raw.series, SERIES_KEYS, replayMs);
  const tempPts = series['lab.env_temp'];
  const tempAgo = valueAgo(tempPts, clock.deltaMs);
  const chill = windChill(temp, wind);
  const envKind = provenance?.environment;
  const envLabel = envKind ? (PROVENANCE[envKind]?.label ?? envKind) : null;

  // Subsystem status from the backend's per-building alert levels.
  const levels = Object.entries(alerts).filter(([k]) => k !== 'overall').map(([, v]) => v);
  const criticalCount = levels.filter((a) => a === 'critical').length;
  const warningCount = levels.filter((a) => a === 'warning').length;
  const normalCount = levels.length - criticalCount - warningCount;
  const subsystemStatus = criticalCount ? 'critical' : warningCount ? 'warning' : undefined;
  const facts = [
    station.commissionedYear && `Est. ${station.commissionedYear}`,
    crewLabel(activeStation),
    isNum(station.elevation_m) && `${station.elevation_m} m elevation`,
  ].filter(Boolean);

  return (
    <Box
      ref={rootRef}
      className="overview-hud"
      // Re-scopes the theme variables: dark over the scene, the active scheme below it.
      data-color-scheme={scheme}
      sx={{
        colorScheme: scheme,
        color: 'text.primary',
        bgcolor: { xs: 'background.default', lg: 'transparent' },
        flex: { xs: 1, lg: 'none' },
        position: { xs: 'relative', lg: 'absolute' },
        inset: { lg: 0 },
        zIndex: 40,
        pointerEvents: { lg: 'none' },
        p: { xs: 4, sm: 6, lg: 6 },
        display: 'flex',
        flexDirection: { xs: 'column', lg: 'row' },
        alignItems: { lg: 'flex-end' },
        justifyContent: 'space-between',
        gap: { xs: 4, lg: 6 },
        '& > *': { pointerEvents: 'auto' },
      }}
    >
      {/* ── Station card ─────────────────────────────────── */}
      <Card component="section" aria-label={`${station.fullName}`} data-testid="hud-station-card" sx={(theme) => ({
        p: { xs: 5, sm: 6, lg: 5 }, width: { lg: 400 }, flex: 'none', boxShadow: { lg: theme.vars.palette.aurora.shadowFloat },
        order: { xs: 2, lg: 0 },
      })}>
        <Typography variant="overline" component="p" sx={{ color: 'text.secondary' }}>Station</Typography>
        <Typography component="h1" sx={{ fontSize: { xs: 24, sm: 28 }, lineHeight: 1.15, fontWeight: 600, letterSpacing: '-0.02em', mt: 1 }}>
          {station.fullName}
        </Typography>
        <Stack direction="row" sx={{ alignItems: 'center', gap: 1.5, mt: 2, flexWrap: 'wrap', color: 'text.secondary' }}>
          <PlaceOutlined sx={{ fontSize: 16 }} />
          <Box component="span" sx={{ typography: 'mono', color: 'text.primary' }}>{formatCoords(activeStation)}</Box>
        </Stack>
        <Typography variant="body2" sx={{ color: 'text.secondary', mt: 1 }}>{station.region}</Typography>
        {facts.length > 0 && (
          <Typography variant="body2" sx={{ color: 'text.secondary', mt: 1.5 }}>{facts.join(' · ')}</Typography>
        )}
        <Stack direction="row" sx={{ gap: 2, mt: 5, flexWrap: 'wrap' }}>
          {onOpenDemo && (
            <Button variant="contained" onClick={onOpenDemo} startIcon={<ScienceOutlined />} data-testid="try-demo" data-tour="try-demo"
              title="Run a simulated fault (shared, resets after 2 minutes) and watch the station respond">
              Try a demo
            </Button>
          )}
          {onOpenTwinInspector && (
            <Button variant={onOpenDemo ? 'outlined' : 'contained'} onClick={onOpenTwinInspector} startIcon={<ViewInArOutlined />} endIcon={<ArrowForwardOutlined />}
              title="Inspect the causal chain behind every modelled value">
              Twin Inspector
            </Button>
          )}
          <Button variant="outlined" onClick={() => openAssistant()} startIcon={<MicNoneOutlined />} data-testid="hud-ask-aurora"
            title="Ask Aurora: voice or text, answers from the station data">
            Ask Aurora
          </Button>
        </Stack>
      </Card>

      {/* ── KPI bento: hero + three compact figures ──────── */}
      <Box
        component="section"
        aria-labelledby="hud-figures-heading"
        data-testid="hud-kpis"
        sx={{
          display: 'grid',
          gap: { xs: 3, lg: 3 },
          order: { xs: 1, lg: 0 },
          width: { lg: 520 },
          flex: 'none',
          gridTemplateColumns: { xs: 'minmax(0, 1fr)', sm: 'repeat(3, minmax(0, 1fr))', lg: 'minmax(0, 1.15fr) minmax(0, 1fr)' },
          gridTemplateAreas: {
            xs: '"hero" "wind" "power" "subs"',
            sm: '"hero hero hero" "wind power subs"',
            lg: '"hero wind" "hero power" "hero subs"',
          },
        }}
      >
        <Typography variant="h2" id="hud-figures-heading" sx={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap' }}>Station figures</Typography>
        <KpiCard hero label="Outside temperature" value={temp} unit="°C" decimals={1} testId="hud-temp"
          status={levelOf(activeAlerts, 'env_temp')}
          series={tempPts}
          delta={temp != null && tempAgo != null ? temp - tempAgo : null}
          deltaLabel={clock.deltaLabel} sparkBucketMs={clock.sparkBucketMs}
          context={[chill != null && `Wind chill ${formatValue(chill, '°C', 1)}`, envLabel].filter(Boolean).join(' · ') || null}
          sx={(theme) => ({ gridArea: 'hero', boxShadow: { lg: theme.vars.palette.aurora.shadowFloat } })} />
        <Box sx={{ gridArea: 'wind', minWidth: 0 }}>
          <HudFigure label="Wind" value={wind} unit="km/h" points={series['lab.env_wind']} bucketMs={clock.sparkBucketMs} status={levelOf(activeAlerts, 'env_wind')} testId="hud-wind" />
        </Box>
        <Box sx={{ gridArea: 'power', minWidth: 0 }}>
          <HudFigure label="Generation" value={power} unit="kW" points={series['generator.gen_power']} bucketMs={clock.sparkBucketMs} status={levelOf(activeAlerts, 'gen_power')} testId="hud-power" />
        </Box>
        <Box sx={{ gridArea: 'subs', minWidth: 0 }}>
          <HudFigure label="Subsystems normal" value={levels.length ? normalCount : null}
            unit={levels.length ? `of ${levels.length}` : undefined}
            status={subsystemStatus} testId="hud-subsystems"
            footer={<SubsystemDots alerts={alerts} />} />
        </Box>
      </Box>
    </Box>
  );
}
