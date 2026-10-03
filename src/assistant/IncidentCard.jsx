/* ═══════════════════════════════════════════════════════════════
   Aurora assistant — the incident card.

   Full (in the panel): what failed, the likely cause (honestly labelled),
   affected systems from the dependency/cascade graph, the decision engine's
   risk, and the playbook's steps as a checklist. Compact (floating, when the
   panel is closed): title, risk, the next step and "Open checklist".
   Playbooks are example procedures, not official NCPOR procedures; it says so.
   ═══════════════════════════════════════════════════════════════ */
import { Box, Button, Card, Checkbox, Chip, Collapse, FormControlLabel, IconButton, Stack, Typography } from '@mui/material';
import CloseOutlined from '@mui/icons-material/CloseOutlined';
import ReportProblemOutlined from '@mui/icons-material/ReportProblemOutlined';
import { useState } from 'react';
import { stationMeta } from '../data/stationConfig';
import { formatValue } from '../lib/format';
import { StatusChip } from '../ui/Status';
import { buildingName } from './actions';
import { formatDuration, nextStep, resolvedSummary } from './briefing';

const RISK_STATUS = { high: 'critical', critical: 'critical', moderate: 'warning', low: 'normal', nominal: 'normal' };
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

function Section({ title, children, testId }) {
  return (
    <Box component="section" sx={{ mt: 2.5 }} data-testid={testId}>
      <Typography component="h4" sx={{ fontSize: 12, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'text.secondary', mb: 1 }}>{title}</Typography>
      {children}
    </Box>
  );
}

export default function IncidentCard({
  incident: inc, book, compact = false, queued = 0, queue = [], ctx, alerts = [], nextStepLabel,
  onOpen, onShowMe, onSnooze, onToggleStep, onControl, onShowChain, onFocus, snoozedUntil, now = 0,
}) {
  const [showCauses, setShowCauses] = useState(false);
  const [showWhy, setShowWhy] = useState(false);
  const station = stationMeta(inc.station).name;
  const resolved = inc.status === 'resolved';
  const sevStatus = resolved ? 'normal' : inc.severity === 'critical' ? 'critical' : 'warning';
  const next = nextStep(inc, book);

  if (compact) {
    return (
      <Card role="alert" data-testid="incident-float" sx={(t) => ({
        position: 'fixed', zIndex: 1250, right: { xs: 8, sm: 24 }, left: { xs: 8, sm: 'auto' }, bottom: { xs: 8, sm: 24 },
        width: { sm: 380 }, p: 4, borderLeft: `4px solid ${t.vars.palette.status[sevStatus]}`, boxShadow: t.vars.palette.aurora.shadowFloat,
      })}>
        <Stack direction="row" sx={{ alignItems: 'center', gap: 2 }}>
          <ReportProblemOutlined sx={(t) => ({ color: t.vars.palette.status[sevStatus], fontSize: 20 })} />
          <Typography sx={{ fontWeight: 600, fontSize: 15, flex: 1 }}>{book.title} · {station}</Typography>
          <IconButton size="small" aria-label="Snooze this incident for 5 minutes" onClick={onSnooze}><CloseOutlined fontSize="small" /></IconButton>
        </Stack>
        <Typography variant="body2" sx={{ color: 'text.secondary', mt: 1 }}>
          {inc.risk ? `Risk: ${inc.risk}. ` : ''}{nextStepLabel ? `Next: ${nextStepLabel}` : ''}
        </Typography>
        <Stack direction="row" sx={{ gap: 2, mt: 3, alignItems: 'center' }}>
          {onShowMe && <Button variant="contained" size="small" onClick={onShowMe} data-testid="incident-float-show">Show me</Button>}
          <Button variant={onShowMe ? 'text' : 'contained'} size="small" onClick={onOpen} data-testid="incident-float-open">Checklist</Button>
          {queued > 0 && <Typography variant="caption" sx={{ color: 'text.secondary' }}>+{queued} more incident{queued > 1 ? 's' : ''}</Typography>}
        </Stack>
      </Card>
    );
  }

  const ctxHere = ctx?.station?.id === inc.station ? ctx : null;
  const failed = (ctxHere?.alerts || alerts).filter((a) => inc.alertIds.includes(a.id));
  const cause = (ctxHere?.anomaly?.candidateCauses || []).find((c) => book.match.anomalyCauses.includes(c.cause));
  const others = inc.affected.filter((b) => !inc.sources.includes(b));
  const summary = resolved ? resolvedSummary(inc, book) : null;

  return (
    <Card variant="outlined" component="section" aria-label={`Incident: ${book.title} at ${station}`} data-testid="incident-card" data-incident={inc.playbookId}
      data-status={inc.status} sx={(t) => ({ p: 4, borderLeft: `4px solid ${t.vars.palette.status[sevStatus]}`, bgcolor: t.vars.palette.aurora.surfaceRaised })}>
      <Stack direction="row" sx={{ alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
        <StatusChip status={sevStatus} label={resolved ? 'Resolved' : cap(inc.severity)} />
        <Typography component="h3" sx={{ fontWeight: 600, fontSize: 16, flex: 1, minWidth: 0 }}>{book.title} · {station}</Typography>
        {inc.sandbox && <Chip size="small" label="Your sandbox" variant="outlined" />}
        {inc.scenario && <StatusChip status="simulated" label="Simulated" />}
      </Stack>
      <Typography variant="caption" component="p" sx={{ color: 'text.secondary', mt: 1 }}>
        Started {new Date(inc.startedAt).toLocaleTimeString()} · Example procedure, not an official NCPOR procedure.
      </Typography>

      {summary ? (
        <Section title="Resolved" testId="incident-summary">
          <Typography variant="body2">Duration {summary.duration}. {summary.affected.length ? `Affected: ${summary.affected.join(', ')}. ` : ''}{summary.stepsDone} of {summary.stepsTotal} steps completed.</Typography>
        </Section>
      ) : (
        <>
          <Section title="What failed" testId="incident-failed">
            {failed.length ? (
              <Box component="ul" sx={{ m: 0, pl: 4 }}>
                {failed.slice(0, 4).map((a) => (
                  <Typography component="li" variant="body2" key={a.id}>
                    {a.buildingName || buildingName(inc.station, a.building || a.buildingId)}: {a.sensorName || a.sensor} {formatValue(a.value, a.unit, 1)}
                    {a.threshold != null ? ` (${a.level} threshold ${formatValue(a.threshold, a.unit, 1)})` : ''}
                  </Typography>
                ))}
              </Box>
            ) : <Typography variant="body2">{book.meaning}</Typography>}
          </Section>
          <Section title="Likely cause" testId="incident-cause">
            {cause ? (
              <Typography variant="body2">{cause.description}. <Box component="span" sx={{ color: 'text.secondary' }}>Likely cause, based on a rule-based match (match strength {cause.matchStrength}); not a diagnosis.</Box></Typography>
            ) : (
              <Typography variant="body2" sx={{ color: 'text.secondary' }}>No diagnosis from the data. Typical causes for this kind of failure are listed below.</Typography>
            )}
            <Button size="small" sx={{ mt: 1, px: 0 }} onClick={() => setShowCauses((v) => !v)} aria-expanded={showCauses}>
              {showCauses ? 'Hide' : 'Show'} typical causes
            </Button>
            <Collapse in={showCauses} unmountOnExit>
              <Typography variant="caption" sx={{ color: 'text.secondary' }}>Typical causes, not a diagnosis:</Typography>
              <Box component="ul" sx={{ m: 0, pl: 4 }}>{book.typicalCauses.map((c) => <Typography component="li" variant="body2" key={c}>{c}</Typography>)}</Box>
            </Collapse>
          </Section>
          <Section title="Affected systems" testId="incident-affected">
            <Stack direction="row" sx={{ gap: 1, flexWrap: 'wrap', alignItems: 'center' }}>
              {inc.sources.map((b) => <Chip key={b} size="small" color="error" variant="outlined" label={buildingName(inc.station, b)} />)}
              {others.length > 0 && <Box component="span" aria-hidden="true" sx={{ color: 'text.secondary' }}>→</Box>}
              {others.map((b) => <Chip key={b} size="small" variant="outlined" label={buildingName(inc.station, b)} />)}
            </Stack>
            <Typography variant="caption" component="p" sx={{ color: 'text.secondary', mt: 1 }}>From the alerts and the cascade rules on the dependency graph.</Typography>
            {onShowChain && <Button size="small" sx={{ px: 0 }} onClick={() => onShowChain(inc)}>Highlight the chain on the page</Button>}
          </Section>
          <Section title="Current risk" testId="incident-risk">
            <Stack direction="row" sx={{ gap: 2, alignItems: 'center' }}>
              {inc.risk ? <StatusChip status={RISK_STATUS[inc.risk] || 'warning'} label={cap(inc.risk)} /> : <Typography variant="body2">Not assessed yet</Typography>}
              <Typography variant="caption" sx={{ color: 'text.secondary', flex: 1 }} data-testid="incident-risk-source">
                {inc.engineConfirmed || !inc.baselineRisk
                  ? 'Decision engine (rule-based risk matrix)'
                  : `Baseline for this failure type; the decision engine (rule-based) currently rates it ${inc.engineRisk || 'not yet'}`}
              </Typography>
              <Button size="small" onClick={() => setShowWhy((v) => !v)} aria-expanded={showWhy} sx={{ minWidth: 0 }}>Why it matters</Button>
            </Stack>
            <Collapse in={showWhy} unmountOnExit>
              <Typography variant="body2" sx={{ color: 'text.secondary', mt: 1 }}>{book.riskRationale}</Typography>
            </Collapse>
          </Section>
        </>
      )}

      <Section title={`Steps (${inc.done.length}/${book.steps.length})`} testId="incident-steps">
        <Stack component="ol" sx={{ m: 0, p: 0, listStyle: 'none' }}>
          {book.steps.map((s, i) => (
            <Box component="li" key={s.do} sx={(t) => ({ borderRadius: '8px', px: 1, ...(next?.index === i && !resolved ? { bgcolor: t.vars.palette.action.hover } : {}) })}>
              <FormControlLabel sx={{ alignItems: 'flex-start', m: 0, py: 0.5 }}
                control={<Checkbox size="small" checked={inc.done.includes(i)} onChange={() => onToggleStep?.(inc.key, i)} sx={{ p: 0.5, mr: 1.5 }}
                  slotProps={{ input: { 'data-testid': `incident-step-${i}` } }} />}
                label={<Typography variant="body2" sx={{ pt: 0.5, textDecoration: inc.done.includes(i) ? 'line-through' : 'none', color: inc.done.includes(i) ? 'text.secondary' : 'text.primary' }}>{i + 1}. {s.do}</Typography>} />
            </Box>
          ))}
        </Stack>
      </Section>

      <Stack direction="row" sx={{ gap: 2, mt: 3, flexWrap: 'wrap' }}>
        {!resolved && <Button size="small" variant="contained" onClick={() => onControl?.('next-step')} data-testid="incident-next">What should I do next?</Button>}
        {!resolved && <Button size="small" onClick={() => onControl?.('snooze')} disabled={(snoozedUntil || 0) > now}>
          {(snoozedUntil || 0) > now ? `Snoozed (${formatDuration(snoozedUntil - now)})` : 'Snooze 5 min'}
        </Button>}
        <Button size="small" onClick={() => onControl?.('dismiss')} data-testid="incident-dismiss">{resolved ? 'Close' : 'Dismiss'}</Button>
      </Stack>

      {queue.length > 1 && (
        <Stack direction="row" sx={{ gap: 1, mt: 3, flexWrap: 'wrap', alignItems: 'center' }} aria-label="Other incidents">
          <Typography variant="caption" sx={{ color: 'text.secondary' }}>Queued by severity:</Typography>
          {queue.filter((q) => q.key !== inc.key).map((q) => (
            <Chip key={q.key} size="small" clickable onClick={() => onFocus?.(q.key)} variant="outlined"
              label={`${q.severity === 'critical' ? 'Critical' : 'Warning'}: ${q.playbookId.replace(/_/g, ' ')} · ${stationMeta(q.station).name}`} />
          ))}
        </Stack>
      )}
    </Card>
  );
}
