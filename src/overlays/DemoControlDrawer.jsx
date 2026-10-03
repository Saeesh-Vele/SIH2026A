/* ═══════════════════════════════════════════════════════════════
   Aurora — Demo Control.

   Injects a predefined synthetic fault into the active station through the
   backend proxy (POST /sim/inject/{id}, /sim/reset). Each scenario is described
   by what it actually overrides (the simulator's targets, approached 30 % per
   tick). Every value it touches is labelled Simulated. Confirmed first.

   Judge mode (PUBLIC_DEMO): anyone may run a scenario. It is shared with every
   visitor, so the backend allows one per station at a time, runs it for 2
   minutes and resets it itself, with a short per-visitor cooldown; its refusals
   ("Another scenario is running…", "you can start another in…") are shown as is.
   ═══════════════════════════════════════════════════════════════ */
import { useState } from 'react';
import { Alert, Box, ButtonBase, LinearProgress, Stack, Typography } from '@mui/material';
import RestartAltOutlined from '@mui/icons-material/RestartAltOutlined';
import { apiGet, apiPost } from '../services/api';
import { usePolling } from '../hooks/usePolling';
import { useNow } from '../hooks/useNow';
import { sensorCatalog, stationMeta } from '../data/stationConfig';
import { formatValue } from '../lib/format';
import { describeFailure } from '../lib/failure';
import { demoRemainingS, mmss, scenarioLabel } from '../lib/publicDemo';
import { ErrorState, LoadingBlock } from '../ui/States';
import { StatusChip } from '../ui/Status';
import WriteButton from '../ui/WriteButton';
import { useAdminToken } from '../hooks/useAdminToken';
import { useConfirm, useToast } from '../ui/feedbackContext';
import SideSheet from './SideSheet';
import { noteOwnScenario } from '../assistant/bus';

function targetText(stationId, targets = {}) {
  const cat = sensorCatalog(stationId);
  return Object.entries(targets).map(([key, v]) => {
    const sensor = key.split('.')[1];
    const c = cat[sensor];
    return `${c?.name ?? sensor} → ${formatValue(v, c?.unit ?? '', 1)}`;
  }).join(', ');
}

/** The backend's friendly refusal (409 busy / 429 cooldown), or a generic description. */
function refusal(err) {
  const msg = err?.body?.detail?.message;
  if (msg) return msg;
  if (err?.status === 429) return 'Too many requests; try again in a minute.';
  if (err?.status === 503) return 'the simulator is offline';
  return describeFailure(err);
}

export default function DemoControlDrawer({ open, onClose, activeStation, publicDemo, receivedAt }) {
  const confirm = useConfirm();
  const toast = useToast();
  const { canWriteShared, loggedIn, publicDemo: publicMode, judge } = useAdminToken();
  const visitor = publicMode && !loggedIn && !canWriteShared;
  const canInject = canWriteShared || publicMode;
  const now = useNow(1000);
  const [state, setState] = useState({ station: null, data: null, error: null });
  const [busy, setBusy] = useState(null);

  usePolling(async (isActive) => {
    try {
      const d = await apiGet(`/sim/scenarios?stationId=${activeStation}`);
      if (isActive()) setState({ station: activeStation, data: d, error: null });
    } catch (err) {
      if (isActive()) setState({ station: activeStation, data: null, error: err });
      throw err;
    }
  }, 3000, { key: activeStation, enabled: Boolean(open) });

  const d = state.station === activeStation ? state.data : null;
  const name = stationMeta(activeStation).name;
  const running = publicDemo?.[activeStation] || null;
  const left = running ? demoRemainingS(running, receivedAt, now) : 0;
  const active = d?.activeScenario ? d.scenarios?.[d.activeScenario] : null;
  const minutes = Math.round((judge.publicDemoDurationS || 120) / 60);

  async function inject(id, sc) {
    const ok = await confirm({
      title: `Run “${sc.name}” at ${name}?`,
      body: sc.kind === 'link'
        ? <>Every visitor sees it: for {minutes} minutes the dashboard freezes on the last data from {name} while the station keeps recording. Then the link returns and everything recorded is sent. Nothing real is disconnected.</>
        : visitor
          ? <>Every visitor sees it: for {minutes} minutes it overrides {targetText(activeStation, sc.targets)}. The values are labelled Simulated and will raise alerts; then the station resets itself. Nothing real is affected.</>
          : <>Overrides for {sc.duration} s: {targetText(activeStation, sc.targets)}. The values are labelled Simulated and may raise alerts. Nothing real is affected.</>,
      confirmLabel: 'Run scenario', danger: !visitor,
    });
    if (!ok) return;
    setBusy(id);
    try {
      await apiPost(`/sim/inject/${id}?stationId=${activeStation}`);
      noteOwnScenario(activeStation, id);
      toast({ text: sc.kind === 'link'
        ? `${name}'s link is down (simulated): watch the readings waiting on site grow. It comes back in ${minutes} minutes.`
        : visitor
          ? `Running “${sc.name}” at ${name}: watch the alerts, the cards and the 3D view. It resets itself in ${minutes} minutes.`
          : `Injected “${sc.name}” into ${name} for ${sc.duration} s.` });
    } catch (err) {
      console.error('[Demo] inject failed', err);
      toast({ severity: err?.status === 409 || err?.status === 429 ? 'info' : 'error', text: `Not started: ${refusal(err)}` });
    } finally {
      setBusy(null);
    }
  }

  async function reset() {
    const ok = await confirm({
      title: visitor ? `End “${scenarioLabel(running)}” at ${name}?` : `Clear injected scenarios on ${name}?`,
      body: 'Ends the simulated fault; the readings return to normal within a minute.', confirmLabel: visitor ? 'End scenario' : 'Reset',
    });
    if (!ok) return;
    setBusy('reset');
    try {
      await apiPost(`/sim/reset?stationId=${activeStation}`);
      toast({ text: `Cleared the scenario on ${name}.` });
    } catch (err) {
      console.error('[Demo] reset failed', err);
      toast({ severity: 'error', text: `Reset failed: ${refusal(err)}.` });
    } finally {
      setBusy(null);
    }
  }

  const resettable = visitor ? running?.startedBy === 'visitor' : Boolean(active || running);

  return (
    <SideSheet open={open} onClose={onClose} title="Demo control" testId="demo-control-panel"
      subtitle={`Run a synthetic fault at ${name} to see the alerts, cascade rules, AI diagnostics and 3D view respond.`}>
      {publicMode && (
        <Alert severity="info" icon={false} sx={{ mb: 4 }} data-testid="demo-public-note">
          Demo scenarios are simulated and reset automatically after {minutes} minutes. They are shared: every visitor sees the one running.
        </Alert>
      )}
      {state.error && state.station === activeStation && (
        <ErrorState sx={{ mb: 3 }}>{state.error?.status === 503 ? 'The simulator is offline: scenarios cannot be run.' : `Scenarios unavailable: ${describeFailure(state.error)}.`}</ErrorState>
      )}
      {!d && !state.error && <LoadingBlock lines={6} />}
      {d && (
        <>
          {(running || active) && (
            <Box sx={(t) => ({ p: 4, mb: 4, borderRadius: '10px', bgcolor: t.vars.palette.aurora.surfaceRaised, border: `1px solid ${t.vars.palette.status.simulated}` })} role="status" data-testid="demo-running">
              <Stack direction="row" sx={{ gap: 2, alignItems: 'center', flexWrap: 'wrap' }}>
                <StatusChip status="simulated" label="Simulated" />
                <Typography sx={{ fontWeight: 600, fontSize: 14 }}>{running ? scenarioLabel(running) : active.name}</Typography>
                {running && (
                  <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                    started by {running.startedBy === 'visitor' ? 'a visitor' : 'the Aurora team'}{left > 0 ? `, resets in ${mmss(left)}` : ''}
                  </Typography>
                )}
              </Stack>
              <LinearProgress sx={{ mt: 2 }} aria-label="Scenario running" variant={running ? 'determinate' : 'indeterminate'}
                value={running ? Math.max(0, Math.min(100, 100 - (left / Math.max(1, (running.endsAt - running.startedAt) / 1000)) * 100)) : undefined} />
            </Box>
          )}
          <Stack component="ul" sx={{ m: 0, p: 0, listStyle: 'none', gap: 2 }}>
            {Object.entries(d.scenarios || {}).map(([id, sc]) => (
              <Box component="li" key={id}>
                <ButtonBase onClick={() => inject(id, sc)} disabled={!canInject || busy != null || (visitor && Boolean(running)) || d.activeScenario === id}
                  data-testid={`demo-scenario-${id}`}
                  sx={(t) => ({
                    display: 'block', width: '100%', textAlign: 'left', p: 4, borderRadius: '10px', bgcolor: t.vars.palette.aurora.surfaceRaised,
                    '&:hover': { bgcolor: t.vars.palette.action.hover }, '&.Mui-disabled': { opacity: 0.6 },
                  })}>
                  <Stack direction="row" sx={{ gap: 2, alignItems: 'baseline' }}>
                    <Typography sx={{ fontWeight: 600, fontSize: 14, flex: 1 }}>{sc.name}</Typography>
                    <Typography variant="caption" sx={{ color: 'text.secondary', fontFeatureSettings: '"tnum" 1' }}>{visitor || sc.kind === 'link' ? `${minutes} min` : `${sc.duration} s`}</Typography>
                  </Stack>
                  <Typography variant="body2" sx={{ color: 'text.secondary', mt: 1 }}>{sc.description}</Typography>
                  {sc.targets && <Typography variant="caption" component="p" sx={{ color: 'text.secondary', mt: 1, mb: 0 }}>Overrides: {targetText(activeStation, sc.targets)}</Typography>}
                </ButtonBase>
              </Box>
            ))}
          </Stack>
          {visitor && running && (
            <Typography variant="body2" sx={{ color: 'text.secondary', mt: 3 }} data-testid="demo-busy-note">
              One scenario runs per station at a time. {left > 0 ? `This one resets in ${mmss(left)}, or try the other station.` : 'It is ending now.'}
            </Typography>
          )}
          {!canInject && <Typography variant="body2" sx={{ color: 'text.secondary', mt: 3 }}>Use Team sign-in (⋮ menu) to run scenarios.</Typography>}
          {resettable && (
            <Box sx={{ mt: 4 }}>
              {visitor ? (
                <WriteButton variant="outlined" startIcon={<RestartAltOutlined />} onClick={reset} disabled={busy != null} data-testid="demo-reset">End this scenario</WriteButton>
              ) : (
                <WriteButton team variant="outlined" startIcon={<RestartAltOutlined />} onClick={reset} disabled={busy != null} data-testid="demo-reset">Reset all scenarios</WriteButton>
              )}
            </Box>
          )}
          <Typography variant="caption" component="p" sx={{ color: 'text.secondary', mt: 3 }}>
            Simulator tick #{d.tickCount}. Values move 30 % of the way to each target per tick.
          </Typography>
        </>
      )}
    </SideSheet>
  );
}
