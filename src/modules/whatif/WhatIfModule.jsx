/* ═══════════════════════════════════════════════════════════════
   Aurora — What-if scenarios (rollout 1B, checkpoint 2).

   POST /simulation/whatif is RULE-BASED: fixed scenario deltas applied to the
   published snapshot, with the coefficients returned as `assumptions`. It is
   not the physics model and the page says so. Read-only: nothing in the twin
   changes, so no sign-in is needed. Scenario descriptions below state exactly
   what the backend changes, and nothing more.
   ═══════════════════════════════════════════════════════════════ */
import { useEffect, useRef, useState } from 'react';
import {
  Alert, Box, Button, Card, Slider, Stack, Table, TableBody, TableCell, TableHead, TableRow, ToggleButton, ToggleButtonGroup, Typography,
} from '@mui/material';
import PlayArrowOutlined from '@mui/icons-material/PlayArrowOutlined';
import { apiPost } from '../../services/api';
import { stationMeta } from '../../data/stationConfig';
import { formatNumber, formatTimeIST, formatValue, isNum } from '../../lib/format';
import { describeFailure } from '../../lib/failure';
import KpiCard from '../../ui/KpiCard';
import PageHeader from '../../ui/PageHeader';
import ProvenanceChip from '../../ui/Provenance';
import ScrollX from '../../ui/ScrollX';
import SectionCard from '../../ui/SectionCard';
import { ErrorState } from '../../ui/States';
import { StatusChip } from '../../ui/Status';
import { MODULES, sectionLabel } from '../../shell/navigation';

const hidden = { position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap' };
const SCENARIOS = [
  { id: 'extreme_cold', name: 'Deep cold', desc: 'Outside temperature −20 °C × intensity; generator load +1.8 kW per °C; fuel +0.18 L per extra kWh.' },
  { id: 'blizzard', name: 'Blizzard', desc: 'Wind +45 km/h and temperature −8 °C × intensity; satellite link degraded to −92 dBm / 0.4 Mbps.' },
  { id: 'gen_failure', name: 'Generator trip', desc: 'Generator power, speed and fuel to zero. No battery or second gen-set is modelled.' },
  { id: 'battery_failure', name: 'Battery / UPS fault', desc: 'Illustrative penalty: generator load +15 %, fuel +18 %. The twin has no battery model.' },
  { id: 'fuel_leak', name: 'Fuel leak', desc: 'Extra 16 L/h × intensity of unmetered fuel loss; autonomy recomputed from the ledger stock.' },
  { id: 'comms_outage', name: 'Satellite link loss', desc: 'Signal −120 dBm, bandwidth 0, uptime 0. Station systems are unchanged.' },
  { id: 'resupply_delay', name: 'Resupply delay', desc: 'Resupply 60 days × intensity late; lists ledger items that would run out first.' },
];
const LEVEL = { critical: 'critical', warning: 'warning', healthy: 'normal' };
const num = (v) => (isNum(v) ? v : null);

function signed(v, unit, d = 1) {
  if (!isNum(v)) return '—';
  if (Math.abs(v) < 0.05) return '±0';
  return `${v > 0 ? '+' : '−'}${formatValue(Math.abs(v), unit, d)}`;
}

export default function WhatIfModule({ activeStation = 'maitri', sensorData = {}, telemetrySource, updatedAt, preset = null }) {
  const meta = MODULES.simulation;
  // `preset`: a run Aurora already made ({scenario, intensity, result, station, nonce}); shown as is.
  const fresh = preset && preset.station === activeStation ? preset : null;
  const [scenario, setScenario] = useState(fresh?.scenario ?? SCENARIOS[0].id);
  const [intensity, setIntensity] = useState(fresh?.intensity ?? 1);
  const [run, setRun] = useState(() => (fresh
    ? { busy: false, result: fresh.result, error: null, key: `${activeStation}|${fresh.scenario}|${fresh.intensity}` }
    : { busy: false, result: null, error: null, key: null }));
  const seen = useRef(fresh?.nonce);
  useEffect(() => {
    if (!preset || preset.station !== activeStation || seen.current === preset.nonce) return;
    seen.current = preset.nonce;
    setScenario(preset.scenario);
    setIntensity(preset.intensity);
    setRun({ busy: false, result: preset.result, error: null, key: `${activeStation}|${preset.scenario}|${preset.intensity}` });
  }, [preset, activeStation]);
  const lab = sensorData.lab || {};
  const gen = sensorData.generator || {};
  const key = `${activeStation}|${scenario}|${intensity}`;
  const result = run.key === key ? run.result : null;
  const sc = SCENARIOS.find((s) => s.id === scenario);

  async function simulate() {
    setRun({ busy: true, result: null, error: null, key });
    try {
      const d = await apiPost('/simulation/whatif', { stationId: activeStation, scenarioId: scenario, intensity: Number(intensity) });
      setRun({ busy: false, result: d, error: null, key });
    } catch (err) {
      console.error('[WhatIf] simulation failed', err);
      setRun({ busy: false, result: null, error: err, key });
    }
  }

  const rows = result ? [
    ['Outside temperature', result.baseline?.lab?.env_temp, result.simulated?.lab?.env_temp, result.deltas?.temperature_delta, '°C'],
    ['Wind', result.baseline?.lab?.env_wind, result.simulated?.lab?.env_wind, result.deltas?.wind_delta, 'km/h'],
    ['Generator load', result.baseline?.generator?.gen_power, result.simulated?.generator?.gen_power, result.deltas?.power_delta, 'kW'],
    ['Fuel burn', result.baseline?.generator?.gen_fuel_rate, result.simulated?.generator?.gen_fuel_rate, result.deltas?.fuel_rate_delta, 'L/h'],
    ['Satellite signal', result.baseline?.commsMast?.comms_signal, result.simulated?.commsMast?.comms_signal,
      num(result.simulated?.commsMast?.comms_signal) != null && num(result.baseline?.commsMast?.comms_signal) != null
        ? result.simulated.commsMast.comms_signal - result.baseline.commsMast.comms_signal : null, 'dBm'],
  ] : [];

  return (
    <Box data-testid="whatif-module">
      <PageHeader
        tourId="simulation"
        section={sectionLabel(meta.section)}
        title={meta.title}
        description={`${meta.description} ${stationMeta(activeStation).name} station.`}
        updatedAt={updatedAt}
        updatedLabel="Baseline snapshot"
        provenance={<ProvenanceChip kind="MODEL-DERIVED" subject="Rule-based" detail="Fixed scenario deltas on the current snapshot. Not the physics model; coefficients are assumptions." />}
      />

      <Typography variant="h2" sx={hidden}>Current baseline</Typography>
      <Box component="section" aria-label="Current baseline" sx={{ display: 'grid', gap: 4, mb: 4, gridTemplateColumns: { xs: 'repeat(2, minmax(0, 1fr))', md: 'repeat(4, minmax(0, 1fr))' } }}>
        <KpiCard label="Outside temperature" value={num(lab.env_temp)} unit="°C" decimals={1} testId="kpi-base-temp" context="Baseline (live snapshot)" />
        <KpiCard label="Wind" value={num(lab.env_wind)} unit="km/h" testId="kpi-base-wind" context="Baseline (live snapshot)" />
        <KpiCard label="Generator load" value={num(gen.gen_power)} unit="kW" decimals={1} testId="kpi-base-power" context="Baseline (live snapshot)" />
        <KpiCard label="Fuel burn" value={num(gen.gen_fuel_rate)} unit="L/h" decimals={1} testId="kpi-base-fuel"
          context={telemetrySource === 'browser-demo' ? 'Browser demo: the backend is needed to run scenarios' : 'Baseline (live snapshot)'} />
      </Box>

      <SectionCard title="Scenario" subtitle="Pick a hazard and its intensity. The run reads the current snapshot and changes nothing." testId="whatif-scenarios">
        <ToggleButtonGroup exclusive value={scenario} onChange={(_, v) => v && setScenario(v)} aria-label="Scenario"
          sx={{ flexWrap: 'wrap', gap: 1.5, '& .MuiToggleButtonGroup-grouped': { border: 1, borderColor: 'aurora.borderControl', borderRadius: '8px !important', m: 0 } }}>
          {SCENARIOS.map((s) => <ToggleButton key={s.id} value={s.id} data-testid={`scenario-${s.id}`} sx={{ px: 3 }}>{s.name}</ToggleButton>)}
        </ToggleButtonGroup>
        <Box sx={{ mt: 3, p: 4, borderRadius: '10px', bgcolor: 'aurora.surfaceRaised' }} aria-live="polite" data-testid="scenario-description">
          <Typography sx={{ fontWeight: 600, fontSize: 14 }}>{sc.name}</Typography>
          <Typography variant="body2" sx={{ color: 'text.secondary', mt: 1 }}>{sc.desc}</Typography>
        </Box>
        <Stack direction={{ xs: 'column', sm: 'row' }} sx={{ gap: { xs: 3, sm: 6 }, alignItems: { sm: 'center' }, mt: 5 }}>
          <Box sx={{ flex: 1, maxWidth: 420 }}>
            <Typography id="intensity-label" variant="label" component="p" sx={{ color: 'text.secondary' }}>
              Intensity <Box component="span" sx={{ color: 'text.primary', fontWeight: 600 }}>×{formatNumber(intensity, 1)}</Box>
            </Typography>
            <Slider value={intensity} min={0.5} max={2} step={0.1} marks={[{ value: 0.5, label: '×0.5' }, { value: 1, label: '×1' }, { value: 2, label: '×2' }]}
              onChange={(_, v) => setIntensity(v)} aria-labelledby="intensity-label" getAriaValueText={(v) => `times ${v}`} data-testid="whatif-intensity" />
          </Box>
          <Button variant="contained" startIcon={<PlayArrowOutlined />} onClick={simulate} disabled={run.busy || telemetrySource === 'browser-demo'} data-testid="whatif-run">
            {run.busy ? 'Running…' : `Run “${sc.name}”`}
          </Button>
        </Stack>
      </SectionCard>

      <Box sx={{ mt: 4 }} aria-live="polite">
        {run.error && run.key === key && (
          <ErrorState onRetry={simulate}>The scenario could not run because {describeFailure(run.error)}.</ErrorState>
        )}
        {result && (
          <SectionCard title={`Result: ${sc.name} ×${formatNumber(result.intensity, 1)}`} testId="whatif-result"
            subtitle={`Baseline: ${result.dataSource} snapshot ${isNum(result.baselineTimestamp) ? formatTimeIST(result.baselineTimestamp) : ''}`}
            provenance={<ProvenanceChip kind="MODEL-DERIVED" subject="Rule-based" />}>
            <Stack direction="row" sx={{ alignItems: 'baseline', gap: 2, flexWrap: 'wrap', mb: 4 }}>
              <Typography variant="label" component="p" sx={{ color: 'text.secondary', m: 0 }}>Severity score (rule-based, 0–100)</Typography>
              <Typography variant="kpi" component="p" sx={{ m: 0 }}>{formatNumber(result.calculatedRisk?.score)}</Typography>
              {result.calculatedRisk?.level && <StatusChip status={LEVEL[result.calculatedRisk.level] || 'warning'} />}
            </Stack>
            <ScrollX label="Baseline and scenario values, scrollable">
              <Table size="small" aria-label="Baseline and scenario values" sx={{ minWidth: 460 }}>
                <TableHead>
                  <TableRow><TableCell sx={{ pl: 0 }}>Quantity</TableCell><TableCell align="right">Baseline</TableCell><TableCell align="right">Scenario</TableCell><TableCell align="right" sx={{ pr: 0 }}>Change</TableCell></TableRow>
                </TableHead>
                <TableBody>
                  {rows.map(([name, b, s, d, unit]) => (
                    <TableRow key={name}>
                      <TableCell sx={{ pl: 0 }}>{name}</TableCell>
                      <TableCell align="right" sx={{ fontFeatureSettings: '"tnum" 1', color: 'text.secondary' }}>{formatValue(num(b), unit, 1)}</TableCell>
                      <TableCell align="right" sx={{ fontFeatureSettings: '"tnum" 1' }}>{formatValue(num(s), unit, 1)}</TableCell>
                      <TableCell align="right" sx={{ pr: 0, fontFeatureSettings: '"tnum" 1', fontWeight: 600 }}>{signed(num(d), unit)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </ScrollX>
            <Box sx={{ display: 'grid', gap: 5, mt: 5, gridTemplateColumns: { xs: 'minmax(0, 1fr)', md: 'repeat(2, minmax(0, 1fr))' } }}>
              <Box>
                <Typography variant="h3" component="h3" sx={{ mb: 2 }}>Consequences</Typography>
                <Stack component="ul" sx={{ m: 0, pl: 4, gap: 1.5, typography: 'body2' }}>
                  {(result.consequences || []).map((c) => <li key={c}>{c}</li>)}
                </Stack>
                {result.affectedSubsystems?.length > 0 && (
                  <Typography variant="body2" sx={{ color: 'text.secondary', mt: 2 }}>Affected: {result.affectedSubsystems.join(', ')}</Typography>
                )}
              </Box>
              <Box>
                <Typography variant="h3" component="h3" sx={{ mb: 2 }}>Suggested action</Typography>
                <Typography variant="body2">{result.calculatedRisk?.recommendedAction}</Typography>
                {result.assumptions?.length > 0 && (
                  <>
                    <Typography variant="h3" component="h3" sx={{ mt: 4, mb: 2 }}>Assumptions</Typography>
                    <Stack component="ul" sx={{ m: 0, pl: 4, gap: 1, typography: 'body2', color: 'text.secondary' }}>
                      {result.assumptions.map((a) => <li key={a}>{a}</li>)}
                    </Stack>
                  </>
                )}
              </Box>
            </Box>
            <Typography variant="caption" component="p" sx={{ color: 'text.secondary', mt: 4 }}>{result.provenance}</Typography>
          </SectionCard>
        )}
        {!result && !run.error && !run.busy && (
          <Card sx={{ p: 6 }} data-testid="whatif-placeholder">
            <Typography variant="body2" sx={{ color: 'text.secondary' }}>Run a scenario to see its effect on the current baseline.</Typography>
          </Card>
        )}
      </Box>
      {telemetrySource === 'browser-demo' && <Alert severity="info" sx={{ mt: 4 }}>The backend is unreachable, so scenarios cannot run.</Alert>}
    </Box>
  );
}
