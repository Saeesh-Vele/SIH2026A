/* ═══════════════════════════════════════════════════════════════
   Aurora — Administration (rollout 1B, checkpoint 3).

   Same data and actions as the legacy AdminPanel:
   - Data sources: NCPOR AWS ingest per station (POST /ncpor/ingest);
   - Alert thresholds: station_config defaults + SQLite overrides
     (GET/POST /admin/config, POST /admin/config/reset), used by the alert
     engine from the next tick;
   - Access: what actually protects writes (one operator token, see
     /admin/session) and the backend's example roles, which are labelled as
     HARDCODED-DEMO and are not enforced (there is no RBAC);
   - Station configuration: station_config.json with source and confidence.
   Every write asks for confirmation and reports through a toast.
   ═══════════════════════════════════════════════════════════════ */
import { lazy, Suspense, useState } from 'react';
import {
  Alert, Box, Card, Chip, Stack, Tab, Table, TableBody, TableCell, TableHead, TableRow, Tabs, TextField, Typography,
} from '@mui/material';
import CloudDownloadOutlined from '@mui/icons-material/CloudDownloadOutlined';
import { apiGet, apiPost, describeApiError } from '../../services/api';
import { usePolling } from '../../hooks/usePolling';
import { useAdminToken } from '../../hooks/useAdminToken';
import { getOperatorName, OPERATOR_NAME_RE, setOperatorName as persistOperatorName } from '../../services/operator';
import { STATION_IDS, stationMeta } from '../../data/stationConfig';
import { stationMetaDetailed } from '../../data/stationConfigDetail';
import { formatNumber } from '../../lib/format';
import { describeFailure } from '../../lib/failure';
import PageHeader from '../../ui/PageHeader';
import NcporFreshness from '../../ui/NcporFreshness';
import ProvenanceChip from '../../ui/Provenance';
import ScrollX from '../../ui/ScrollX';
import SectionCard from '../../ui/SectionCard';
import { ErrorState, LoadingBlock } from '../../ui/States';
import WriteButton from '../../ui/WriteButton';
import { SandboxNotice, SandboxTag } from '../../ui/Sandbox';
import { useConfirm, useToast } from '../../ui/feedbackContext';
import { MODULES, sectionLabel } from '../../shell/navigation';

const TABS = [
  { id: 'sources', label: 'Data sources' },
  { id: 'thresholds', label: 'Alert thresholds' },
  { id: 'access', label: 'Access' },
  { id: 'config', label: 'Station configuration' },
];
// The team's visit counts: a separate chunk, loaded only when the tab is opened.
const VisitsPanel = lazy(() => import('./VisitsPanel'));
const VISITS_TAB = { id: 'visits', label: 'Visits' };
const LEVELS = [['low', 'warning'], ['low', 'critical'], ['high', 'warning'], ['high', 'critical']];

function DataSources({ stationNames, onIngest, busy, system }) {
  return (
    <Stack sx={{ gap: 3 }}>
      <Card sx={{ p: 5, bgcolor: 'aurora.surfaceRaised', borderColor: 'transparent' }}>
        <Stack direction={{ xs: 'column', md: 'row' }} sx={{ gap: 3, alignItems: { md: 'center' } }}>
          <Box sx={{ flex: 1 }}>
            <Stack direction="row" sx={{ gap: 2, alignItems: 'center', mb: 1 }}>
              <Typography sx={{ fontWeight: 600 }}>NCPOR AWS live data page</Typography>
              <ProvenanceChip kind="REAL" />
            </Stack>
            <Typography variant="body2" sx={{ color: 'text.secondary' }}>
              Weather station observations from data.ncpor.res.in, fetched automatically for both stations, each value checked
              for plausibility, and stored in the station database.
            </Typography>
            <Typography sx={{ typography: 'mono', fontSize: 12, color: 'text.secondary', mt: 1 }}>https://data.ncpor.res.in/</Typography>
            <NcporFreshness stations={STATION_IDS} title="Sync status" sx={{ mt: 3 }} />
          </Box>
          <Stack direction="row" sx={{ gap: 2, flexWrap: 'wrap' }}>
            {STATION_IDS.map((sid) => (
              <WriteButton team key={sid} variant="outlined" size="small" startIcon={<CloudDownloadOutlined />} disabled={busy}
                onClick={() => onIngest(sid)} data-testid={`admin-ingest-${sid}`}>
                Sync {stationNames[sid]} now
              </WriteButton>
            ))}
          </Stack>
        </Stack>
      </Card>
      <Card sx={{ p: 5, bgcolor: 'aurora.surfaceRaised', borderColor: 'transparent' }}>
        <Stack direction="row" sx={{ gap: 2, alignItems: 'center', mb: 1 }}>
          <Typography sx={{ fontWeight: 600 }}>ERA5 reanalysis (Open-Meteo)</Typography>
          <ProvenanceChip kind="REANALYSIS" />
        </Stack>
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>
          Hourly reanalysis, cached per 7-day window and replayed by the simulator. Change the window in the Twin inspector.
        </Typography>
      </Card>
      <Card sx={{ p: 5, bgcolor: 'aurora.surfaceRaised', borderColor: 'transparent' }}>
        <Stack direction="row" sx={{ gap: 2, alignItems: 'center', mb: 1 }}>
          <Typography sx={{ fontWeight: 600 }}>National Polar Data Center archive</Typography>
          <Chip size="small" variant="outlined" label="Not integrated" />
        </Stack>
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>No NPDC ingest is implemented. Listed as a future source only.</Typography>
        <Typography sx={{ typography: 'mono', fontSize: 12, color: 'text.secondary', mt: 1 }}>https://npdc.ncpor.res.in/</Typography>
      </Card>
      {system?.ingestionSource && (
        <Typography variant="caption" sx={{ color: 'text.secondary' }}>Backend {system.version}: {system.ingestionSource}.</Typography>
      )}
    </Stack>
  );
}

export default function AdminModule({ activeStation = 'maitri' }) {
  const meta = MODULES.admin;
  const confirm = useConfirm();
  const toast = useToast();
  const { writeProtected, canWrite, canWriteShared, sandbox } = useAdminToken();
  const [tab, setTab] = useState('sources');
  const [state, setState] = useState({ station: null, config: null, error: null });
  const [attempt, setAttempt] = useState(0);
  const [edits, setEdits] = useState({});
  const [name, setName] = useState(getOperatorName);
  const [busy, setBusy] = useState(false);

  usePolling(async (isActive) => {
    try {
      const d = await apiGet(`/admin/config?stationId=${activeStation}`);
      if (isActive()) setState({ station: activeStation, config: d, error: null });
    } catch (err) {
      console.error('[Admin] config failed', err);
      if (isActive()) setState({ station: activeStation, config: null, error: err });
      throw err;
    }
  }, 30000, { key: `${activeStation}:${attempt}` });
  const reload = () => { setEdits({}); setAttempt((n) => n + 1); };

  const cfg = state.station === activeStation ? state.config : null;
  const effective = cfg?.stationId === activeStation ? cfg.thresholds : null;
  const valueOf = (s, dir, lvl) => edits[s]?.[dir]?.[lvl] ?? String(effective?.[s]?.[dir]?.[lvl] ?? '');
  const setEdit = (s, dir, lvl, v) => setEdits((p) => ({ ...p, [s]: { ...p[s], [dir]: { ...p[s]?.[dir], [lvl]: v } } }));
  const isOverridden = (s) => (cfg?.thresholdOverrides || []).some((o) => o.sensor === s && o.stationId === activeStation && !o.sandbox);
  const inMySandbox = (s) => (cfg?.sandboxOverrides || []).some((o) => o.sensor === s);
  // A visitor's Reset removes only their own sandbox values; the team's resets the shared override.
  const canReset = (s) => (sandbox ? inMySandbox(s) : isOverridden(s));
  const nameOk = OPERATOR_NAME_RE.test(name.trim());
  const stationNames = Object.fromEntries(STATION_IDS.map((sid) => [sid, stationMeta(sid).name]));

  const changes = {};
  let changeCount = 0;
  const invalid = [];
  Object.entries(edits).forEach(([s, dirs]) => Object.entries(dirs).forEach(([dir, lv]) => Object.entries(lv).forEach(([lvl, raw]) => {
    const v = Number(raw);
    if (raw === '' || Number.isNaN(v)) { invalid.push(`${s} ${dir} ${lvl}`); return; }
    if (v === effective?.[s]?.[dir]?.[lvl]) return;
    changes[s] = { ...changes[s], [dir]: { ...changes[s]?.[dir], [lvl]: v } };
    changeCount += 1;
  })));

  async function ingest(sid) {
    const ok = await confirm({
      title: `Sync NCPOR data for ${stationNames[sid]} now?`,
      body: 'Fetches the NCPOR AWS live page now (it is also synced automatically), checks each value and stores the new observations.',
      confirmLabel: 'Sync now',
    });
    if (!ok) return;
    setBusy(true);
    try {
      const res = await apiPost(`/ncpor/ingest?stationId=${sid}`);
      const r = res?.results?.[sid];
      toast(r?.status === 'success'
        ? { text: `Synced ${formatNumber(r.records_ingested)} NCPOR readings for ${stationNames[sid]}${r.suspect ? `; ${r.suspect} flagged suspect` : ''}.` }
        : { severity: 'error', text: `NCPOR sync failed for ${stationNames[sid]}: ${r?.error || 'no result'}. The last good data is kept.` });
    } catch (err) {
      console.error('[Admin] ingest failed', err);
      toast({ severity: 'error', text: `Ingest failed: ${describeApiError(err)}` });
    } finally {
      setBusy(false);
    }
  }

  async function save(e) {
    e.preventDefault();
    if (!changeCount) return;
    const ok = await confirm({
      title: `Save ${changeCount} threshold value${changeCount > 1 ? 's' : ''}?`,
      body: sandbox
        ? `Your alerts for ${stationMeta(activeStation).name} use them straight away. Only you see them, and they reset after an hour.`
        : `The alert engine uses them for ${stationMeta(activeStation).name} from the next tick. Recorded as ${name.trim()}.`,
      confirmLabel: 'Save thresholds',
    });
    if (!ok) return;
    setBusy(true);
    try {
      const res = await apiPost('/admin/config', { stationId: activeStation, thresholds: changes, updatedBy: name.trim() });
      persistOperatorName(name);
      toast({ text: res.sandbox
        ? `Saved ${res.valuesSaved} value(s) in your sandbox. Your alerts now use them; other visitors still see the station's own thresholds.`
        : `Saved ${res.valuesSaved} value(s). The alert engine uses them from the next tick.` });
      reload();
    } catch (err) {
      console.error('[Admin] save thresholds failed', err);
      toast({ severity: 'error', text: `Not saved: ${describeApiError(err)}` });
    } finally {
      setBusy(false);
    }
  }

  async function reset(sensor, label) {
    const ok = await confirm({
      title: `Reset ${label} to its default?`,
      body: 'Removes this station’s override; the station_config.json default applies from the next tick.',
      confirmLabel: 'Reset', danger: true,
    });
    if (!ok) return;
    try {
      const res = await apiPost('/admin/config/reset', { stationId: activeStation, sensor, updatedBy: nameOk ? name.trim() : getOperatorName() });
      toast({ text: `Reset ${label}: ${res.removed} override value(s) removed.` });
      reload();
    } catch (err) {
      console.error('[Admin] reset failed', err);
      toast({ severity: 'error', text: `Reset failed: ${describeApiError(err)}` });
    }
  }

  // Visits is for the team only (the read needs the token); visitors never see the tab.
  const tabs = canWriteShared ? [...TABS, VISITS_TAB] : TABS;
  const shownTab = tabs.some((t) => t.id === tab) ? tab : 'sources';

  return (
    <Box data-testid="admin-module">
      <PageHeader section={sectionLabel(meta.section)} title={meta.title} description={meta.description} tourId="admin" />
      <SectionCard title="System" subtitle={`Settings for ${stationMeta(activeStation).fullName} unless a tab says otherwise`} testId="admin-card">
        <Tabs value={shownTab} onChange={(_, v) => setTab(v)} variant="scrollable" allowScrollButtonsMobile aria-label="Administration" sx={{ mb: 4 }}>
          {tabs.map((t) => <Tab key={t.id} value={t.id} label={t.label} data-testid={`admin-tab-${t.id}`} />)}
        </Tabs>
        {state.error && <ErrorState sx={{ mb: 3 }} onRetry={reload}>Configuration unavailable because {describeFailure(state.error)}.</ErrorState>}

        <Box role="tabpanel" aria-label={tabs.find((t) => t.id === shownTab).label}>
          {shownTab === 'sources' && <DataSources stationNames={stationNames} onIngest={ingest} busy={busy} system={cfg?.system} />}

          {shownTab === 'thresholds' && (
            !cfg ? (state.error ? null : <LoadingBlock lines={8} />) : (
              <Box component="form" onSubmit={save} data-testid="thresholds-form" noValidate>
                <Typography variant="body2" sx={{ color: 'text.secondary', mb: 3 }}>
                  Defaults come from station_config.json; saved values are per-station overrides in SQLite. An alert clears after
                  {' '}{cfg.alertResolveTicks} consecutive normal ticks.
                </Typography>
                <SandboxNotice>Change a threshold and your own alerts follow it straight away, on every page. Other visitors keep seeing the station&apos;s own thresholds.</SandboxNotice>
                {!canWrite && (
                  <Alert severity="info" sx={{ mb: 3 }} data-testid="thresholds-readonly">
                    Read-only: use Team sign-in (⋮ menu) to edit thresholds.
                  </Alert>
                )}
                <ScrollX label="Alert thresholds, scrollable">
                  <Table size="small" aria-label="Alert thresholds" sx={{ minWidth: 760 }}>
                    <TableHead>
                      <TableRow>
                        <TableCell sx={{ pl: 0 }}>Sensor</TableCell>
                        <TableCell>Unit (range)</TableCell>
                        <TableCell align="right">Low warn</TableCell><TableCell align="right">Low crit</TableCell>
                        <TableCell align="right">High warn</TableCell><TableCell align="right">High crit</TableCell>
                        <TableCell sx={{ pr: 0 }}><Box component="span" sx={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>Reset</Box></TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {Object.entries(cfg.thresholdRules).map(([s, rule]) => (
                        <TableRow key={s} data-sensor={s}>
                          <TableCell sx={{ pl: 0, minWidth: 200 }} title={rule.basis}>
                            {rule.name}
                            {isOverridden(s) && <Chip size="small" label="Override" sx={{ ml: 1 }} />}
                            <SandboxTag show={inMySandbox(s)} sx={{ ml: 1 }} />
                            <Typography variant="caption" component="div" sx={{ color: 'text.secondary', typography: 'mono', fontSize: 11 }}>{s} · {rule.building}</Typography>
                          </TableCell>
                          <TableCell sx={{ color: 'text.secondary', whiteSpace: 'nowrap' }}>{rule.unit} ({rule.min}–{rule.max})</TableCell>
                          {LEVELS.map(([dir, lvl]) => (
                            <TableCell key={`${dir}-${lvl}`} align="right" sx={{ py: 1 }}>
                              {effective?.[s]?.[dir] ? (
                                <TextField size="small" type="number" value={valueOf(s, dir, lvl)} onChange={(e) => setEdit(s, dir, lvl, e.target.value)}
                                  error={edits[s]?.[dir]?.[lvl] !== undefined && (edits[s][dir][lvl] === '' || Number.isNaN(Number(edits[s][dir][lvl])))}
                                  slotProps={{ htmlInput: { step: 'any', readOnly: !canWrite, 'aria-label': `${rule.name} ${dir} ${lvl}`, 'data-threshold': `${s}.${dir}.${lvl}`, style: { textAlign: 'right' } } }}
                                  sx={{ width: 104 }} />
                              ) : <Box component="span" sx={{ color: 'text.disabled' }}>—</Box>}
                            </TableCell>
                          ))}
                          <TableCell sx={{ pr: 0 }}>
                            {canReset(s) && <WriteButton size="small" onClick={() => reset(s, rule.name)} data-testid={`admin-reset-${s}`}>Reset</WriteButton>}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </ScrollX>
                <Stack direction={{ xs: 'column', sm: 'row' }} sx={{ gap: 3, alignItems: { sm: 'center' }, mt: 4 }}>
                  <TextField size="small" label="Your name (recorded with the change)" value={name} onChange={(e) => setName(e.target.value)}
                    error={!nameOk} helperText={nameOk ? 'Not a login: write access is the operator token.' : "2–60 letters, digits, spaces or . , ' ( ) _ -"}
                    slotProps={{ htmlInput: { maxLength: 60, readOnly: !canWrite } }} sx={{ minWidth: 280 }} />
                  <Box sx={{ flex: 1 }} />
                  <Typography variant="body2" sx={{ color: invalid.length ? 'status.warning' : 'text.secondary' }}>
                    {invalid.length ? `${invalid.length} invalid value(s)` : changeCount ? `${changeCount} unsaved change(s)` : 'No changes'}
                  </Typography>
                  <WriteButton type="submit" variant="contained" disabled={busy || !changeCount || invalid.length > 0 || !nameOk} data-testid="admin-save">
                    {busy ? 'Saving…' : 'Save thresholds'}
                  </WriteButton>
                </Stack>
              </Box>
            )
          )}

          {shownTab === 'access' && (
            <Stack sx={{ gap: 4 }}>
              <Alert severity="info">
                {writeProtected === true
                  ? 'Write protection is on: changing thresholds, the ledger, alerts, commands or the simulator needs the operator token. Viewing never does.'
                  : writeProtected === false
                    ? 'Write protection is off on this server (ADMIN_TOKEN is not set): every control is enabled for everyone. Fine for local development only.'
                    : 'Checking write protection…'}
                {' '}Names entered with changes are recorded in audit logs; they are not accounts.
              </Alert>
              <Box>
                <Stack direction="row" sx={{ gap: 2, alignItems: 'center', mb: 2 }}>
                  <Typography variant="h3" component="h3">Example roles</Typography>
                  <ProvenanceChip kind="HARDCODED-DEMO" detail={cfg?.usersProvenance} />
                </Stack>
                <Typography variant="body2" sx={{ color: 'text.secondary', mb: 2 }}>
                  Illustrative only: there are no user accounts or role-based access control. Nothing below is enforced.
                </Typography>
                {!cfg ? <LoadingBlock lines={4} /> : (
                  <ScrollX label="Example roles, scrollable">
                    <Table size="small" aria-label="Example roles (not enforced)" sx={{ minWidth: 520 }}>
                      <TableHead><TableRow><TableCell sx={{ pl: 0 }}>Example user</TableCell><TableCell>Role</TableCell><TableCell>Station</TableCell><TableCell sx={{ pr: 0 }}>Would allow</TableCell></TableRow></TableHead>
                      <TableBody>
                        {(cfg.users || []).map((u) => (
                          <TableRow key={u.id}><TableCell sx={{ pl: 0 }}>{u.name}</TableCell><TableCell>{u.role}</TableCell><TableCell>{u.station}</TableCell><TableCell sx={{ pr: 0, color: 'text.secondary' }}>{u.access}</TableCell></TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </ScrollX>
                )}
              </Box>
            </Stack>
          )}

          {shownTab === 'visits' && <Suspense fallback={<LoadingBlock lines={6} />}><VisitsPanel /></Suspense>}

          {shownTab === 'config' && (
            <Stack sx={{ gap: 4 }}>
              <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                From simulator/station_config.json (also served at /api/config/stations), with the source and confidence of each value.
                “Confirm” marks values that still need NCPOR confirmation. Physics parameters are in the Twin inspector.
              </Typography>
              {STATION_IDS.map((sid) => (
                <Box key={sid} data-testid={`station-meta-${sid}`}>
                  <Typography variant="h3" component="h3" sx={{ mb: 1 }}>{stationMeta(sid).fullName}</Typography>
                  <ScrollX label={`${stationMeta(sid).name} configuration, scrollable`}>
                    <Table size="small" aria-label={`${stationMeta(sid).name} configuration`} sx={{ minWidth: 640 }}>
                      <TableHead><TableRow><TableCell sx={{ pl: 0 }}>Field</TableCell><TableCell>Value</TableCell><TableCell>Confidence</TableCell><TableCell sx={{ pr: 0 }}>Source</TableCell></TableRow></TableHead>
                      <TableBody>
                        {Object.entries(stationMetaDetailed(sid)).filter(([, v]) => v && typeof v === 'object' && 'value' in v).map(([k, v]) => (
                          <TableRow key={k}>
                            <TableCell sx={{ pl: 0, typography: 'mono', fontSize: 12 }}>{k}</TableCell>
                            <TableCell sx={{ fontWeight: 500 }}>{v.value == null ? 'not established' : Array.isArray(v.value) ? v.value.join(', ') : String(v.value)}</TableCell>
                            <TableCell>{v.confidence}{v.needsNcporConfirmation ? ' · confirm' : ''}</TableCell>
                            <TableCell sx={{ pr: 0, color: 'text.secondary', fontSize: 12 }}>{v.source}{v.note ? `. ${v.note}` : ''}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </ScrollX>
                </Box>
              ))}
            </Stack>
          )}
        </Box>
      </SectionCard>
    </Box>
  );
}
