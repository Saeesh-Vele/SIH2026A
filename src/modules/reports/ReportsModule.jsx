/* ═══════════════════════════════════════════════════════════════
   Aurora — Reports (rollout 1B, checkpoint 2).

   A station status document built from the same sources as the legacy
   ReportPanel: latest stored weather (/ncpor/live), rule-based risk (/risk),
   the logistics ledger (/logistics), active alerts (/alerts), thresholds
   (/admin/config) and the live telemetry snapshot. Each source fails on its
   own and is reported as unavailable, never replaced with a number.

   The document is a light "paper" in both colour schemes, so the screen view
   is what prints; the print stylesheet (App.css) hides the app shell and the
   toolbar. CSV and JSON exports carry the same values and provenance.
   ═══════════════════════════════════════════════════════════════ */
import { useEffect, useState } from 'react';
import {
  Box, Button, Card, Divider, MenuItem, Stack, Table, TableBody, TableCell, TableHead, TableRow, TextField, Typography,
} from '@mui/material';
import DownloadOutlined from '@mui/icons-material/DownloadOutlined';
import PrintOutlined from '@mui/icons-material/PrintOutlined';
import { apiGet } from '../../services/api';
import { crewLabel, formatCoords, STATION_IDS, stationMeta } from '../../data/stationConfig';
import { stationMetaDetailed } from '../../data/stationConfigDetail';
import { formatDateTimeIST, formatNumber, formatValue, isNum } from '../../lib/format';
import { FROSTBITE_SOURCE } from '../../lib/windChill';
import PageHeader from '../../ui/PageHeader';
import ScrollX from '../../ui/ScrollX';
import ProvenanceChip, { PROVENANCE } from '../../ui/Provenance';
import { LoadingBlock } from '../../ui/States';
import { MODULES, sectionLabel } from '../../shell/navigation';

function settle(promise, label) {
  return promise.then(
    (data) => ({ data, error: null }),
    (err) => {
      console.error(`[Report] ${label} failed`, err);
      return { data: null, error: err?.kind === 'http' ? `HTTP ${err.status}` : 'backend unreachable' };
    },
  );
}
const WEATHER_KIND = { REAL: 'Real (NCPOR AWS)', REANALYSIS: 'Reanalysis (ERA5)', 'HARDCODED-DEMO': 'Built-in default (no observations stored)' };
const num = (v) => (isNum(v) ? v : null);

function Section({ n, title, children }) {
  return (
    <Box component="section" sx={{ mt: 6, breakInside: 'avoid' }}>
      <Typography component="h2" sx={{ fontSize: 15, fontWeight: 600, letterSpacing: '0.02em', mb: 2, pb: 1, borderBottom: 1, borderColor: 'divider' }}>
        {n}. {title}
      </Typography>
      {children}
    </Box>
  );
}

function Facts({ rows }) {
  return (
    <Box component="dl" sx={{ m: 0, display: 'grid', gridTemplateColumns: { xs: 'minmax(0, 1fr)', sm: '200px minmax(0, 1fr)' }, columnGap: 4, rowGap: 1.5, fontSize: 14 }}>
      {rows.map(([k, v]) => (
        <Box key={k} sx={{ display: 'contents' }}>
          <Box component="dt" sx={{ color: 'text.secondary' }}>{k}</Box>
          <Box component="dd" sx={{ m: 0, mb: { xs: 1.5, sm: 0 } }}>{v}</Box>
        </Box>
      ))}
    </Box>
  );
}

export default function ReportsModule({ activeStation = 'maitri', sensorData = {}, provenance, telemetrySource, timestamp }) {
  const meta = MODULES.reports;
  // The picker follows the top-bar station until the user picks another one here.
  const [picked, setPicked] = useState({ for: activeStation, value: activeStation });
  const station = picked.for === activeStation ? picked.value : activeStation;
  const setStation = (value) => setPicked({ for: activeStation, value });
  const [report, setReport] = useState({ station: null, data: null });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    Promise.all([
      settle(apiGet(`/ncpor/live?stationId=${station}`), 'weather'),
      settle(apiGet(`/risk?stationId=${station}`), 'risk'),
      settle(apiGet(`/logistics?stationId=${station}`), 'logistics'),
      settle(apiGet(`/alerts?stationId=${station}`), 'alerts'),
      settle(apiGet(`/admin/config?stationId=${station}`), 'config'),
    ]).then(([w, r, l, a, c]) => {
      if (!active) return;
      setReport({ station, data: {
        weather: w.data?.weather || null, risk: r.data || null, logistics: l.data?.items || null,
        alerts: a.data?.activeAlerts || null, config: c.data || null,
        errors: { weather: w.error, risk: r.error, logistics: l.error, alerts: a.error, config: c.error },
        generatedAt: Date.now(),
      } });
    });
    return () => { active = false; };
  }, [station, attempt]);

  const ready = report.station === station && report.data;
  const d = ready ? report.data : null;
  const m = stationMeta(station);
  const md = stationMetaDetailed(station);
  // Live telemetry belongs to the station on screen; for the other station it is not loaded.
  const live = station === activeStation ? sensorData : {};
  const gen = live.generator || {};
  const lq = live.livingQuarters || {};
  const equipKind = telemetrySource === 'browser-demo' ? 'SIMULATED' : provenance?.equipment || 'MODEL-DERIVED';
  const w = d?.weather;
  const wKind = w?.provenance;
  const specific = num(gen.gen_fuel_rate) != null && num(gen.gen_power) ? gen.gen_fuel_rate / gen.gen_power : null;
  const failed = d ? Object.entries(d.errors).filter(([, e]) => e) : [];
  const docId = d ? `AURORA/${station.toUpperCase()}/${new Date(d.generatedAt).toISOString().slice(0, 10)}` : `AURORA/${station.toUpperCase()}`;

  function download(name, type, content) {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  }
  const stamp = new Date().toISOString().slice(0, 10);
  const exportJson = () => d && download(`Aurora_${station}_status_report_${stamp}.json`, 'application/json', JSON.stringify({
    documentId: docId, station, stationName: m.fullName, generatedAt: new Date(d.generatedAt).toISOString(),
    telemetry: { snapshotAt: station === activeStation && isNum(timestamp) ? new Date(timestamp).toISOString() : null, provenance: equipKind, sensors: live },
    ...d,
  }, null, 2));
  const exportCsv = () => {
    if (!d) return;
    const wProv = w ? `${wKind} ${w.dataset || ''} (${w.source})`.trim() : 'unavailable';
    const rows = [
      ['Metric', 'Value', 'Unit', 'Provenance'],
      ['Station', m.fullName, '', 'station_config.json'],
      ['Coordinates', formatCoords(station), '', 'station_config.json'],
      ['Winter crew', crewLabel(station) ?? '', '', `station_config.json (${md.personnelWinter?.confidence} confidence)`],
      ['Air temperature', w?.temperature_c ?? '', '°C', wProv],
      ['Wind speed', w?.wind_speed_kmh ?? '', 'km/h', wProv],
      ['Air pressure', w?.air_pressure_hpa ?? '', 'hPa', wProv],
      ['Relative humidity', w?.relative_humidity_pct ?? '', '%', wProv],
      ['Wind chill', d.risk?.wind_chill_c ?? '', '°C', 'MODEL-DERIVED (JAG/TI wind-chill formula)'],
      ['Risk index', d.risk?.risk_score ?? '', '0-100', 'MODEL-DERIVED (rule-based)'],
      ['Generator power', gen.gen_power ?? '', 'kW', equipKind],
      ['Generator fuel rate', gen.gen_fuel_rate ?? '', 'L/h', equipKind],
      ...(d.logistics || []).map((i) => [i.name, i.current, i.unit,
        `OPERATOR-ENTERED; ${i.daysRemaining == null ? 'no daily use' : `${i.daysRemaining} days at ${i.dailyUse} ${i.unit}/day`}`]),
    ];
    download(`Aurora_${station}_metrics_${stamp}.csv`, 'text/csv;charset=utf-8',
      rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n'));
  };

  return (
    <Box data-testid="reports-module">
      <Box className="no-print">
        <PageHeader
          section={sectionLabel(meta.section)}
          title={meta.title}
          description={meta.description}
          provenance={<ProvenanceChip kind="MODEL-DERIVED" subject="Prototype document" detail="Generated by the Aurora demo. Not an official NCPOR / MoES document." />}
        />
        <Card sx={{ p: 4, mb: 4 }}>
          <Stack direction={{ xs: 'column', sm: 'row' }} sx={{ gap: 3, alignItems: { sm: 'center' } }}>
            <TextField select size="small" label="Station" value={station} onChange={(e) => setStation(e.target.value)} sx={{ minWidth: 220 }}>
              {STATION_IDS.map((sid) => <MenuItem key={sid} value={sid}>{stationMeta(sid).name} ({stationMeta(sid).region})</MenuItem>)}
            </TextField>
            <Box sx={{ flex: 1 }} />
            <Button variant="contained" startIcon={<PrintOutlined />} onClick={() => window.print()} disabled={!ready} data-testid="report-print">Print / save as PDF</Button>
            <Button variant="outlined" startIcon={<DownloadOutlined />} onClick={exportCsv} disabled={!ready}>CSV</Button>
            <Button variant="outlined" startIcon={<DownloadOutlined />} onClick={exportJson} disabled={!ready}>JSON</Button>
            <Button onClick={() => setAttempt((n) => n + 1)}>Refresh</Button>
          </Stack>
        </Card>
      </Box>

      {/* The document: light paper in both schemes, so screen and print match. */}
      <Card data-color-scheme="light" className="report-document" data-testid="report-document" sx={{
        colorScheme: 'light', color: 'text.primary', bgcolor: 'background.paper', borderColor: 'divider',
        p: { xs: 5, sm: 10 }, maxWidth: 900, mx: 'auto',
      }}>
        <Stack direction={{ xs: 'column', sm: 'row' }} sx={{ justifyContent: 'space-between', gap: 3 }}>
          <Box>
            <Typography sx={{ fontSize: 12, fontWeight: 600, letterSpacing: '0.08em', color: 'text.secondary' }}>AURORA DIGITAL TWIN · PROTOTYPE</Typography>
            <Typography sx={{ fontSize: 12, color: 'text.secondary' }}>Not an official NCPOR / MoES document</Typography>
          </Box>
          <Box sx={{ textAlign: { sm: 'right' } }}>
            <Typography sx={{ typography: 'mono', fontSize: 12 }}>{docId}</Typography>
            <Typography sx={{ fontSize: 12, color: 'text.secondary' }}>Generated {d ? formatDateTimeIST(d.generatedAt) : '—'}</Typography>
          </Box>
        </Stack>
        <Typography component="h1" sx={{ fontSize: 28, fontWeight: 600, letterSpacing: '-0.02em', mt: 6 }}>Station status report</Typography>
        <Typography sx={{ color: 'text.secondary' }}>{m.fullName} · stored weather and model-derived operations summary</Typography>

        {!ready ? <Box sx={{ mt: 6 }}><LoadingBlock lines={10} /></Box> : (
          <>
            {failed.length > 0 && (
              <Box role="status" sx={{ mt: 4, p: 3, borderRadius: '8px', bgcolor: 'status.warningTint', color: 'status.warning', fontSize: 14 }}>
                Unavailable sources: {failed.map(([k, e]) => `${k} (${e})`).join(', ')}. Their sections say so.
              </Box>
            )}

            <Section n={1} title="Station">
              <Facts rows={[
                ['Station', m.fullName],
                ['Location', `${formatCoords(station)} · ${m.region}`],
                ['Elevation', `${m.elevation_m} m (${md.elevation_m?.confidence} confidence)`],
                ['Winter crew', `${crewLabel(station) ?? '—'} (${md.personnelWinter?.confidence} confidence; station_config.json)`],
                ['Alerts', d.errors.alerts ? 'Unknown (alerts unavailable)' : d.alerts.length ? `${d.alerts.length} active` : 'No active alerts'],
                ['Telemetry snapshot', station === activeStation && isNum(timestamp) ? `${formatDateTimeIST(timestamp)} · ${PROVENANCE[equipKind]?.label ?? equipKind}` : 'Not loaded for this station (switch station to include live figures)'],
              ]} />
            </Section>

            <Section n={2} title="Latest stored weather observation">
              <Typography variant="body2" sx={{ color: 'text.secondary', mb: 3 }}>
                {!w ? `Unavailable (${d.errors.weather || 'no data'}).`
                  : `${WEATHER_KIND[wKind] || wKind}${w.dataset ? ` · ${w.dataset}` : ''} · ${w.source}${isNum(w.observedAt) ? ` · observed ${formatDateTimeIST(w.observedAt)}` : ''}.`}
              </Typography>
              {w && (
                <Table size="small" aria-label="Latest stored weather">
                  <TableHead><TableRow><TableCell sx={{ pl: 0 }}>Parameter</TableCell><TableCell align="right">Value</TableCell><TableCell sx={{ pr: 0 }}>Provenance</TableCell></TableRow></TableHead>
                  <TableBody>
                    {[['Air temperature', formatValue(num(w.temperature_c), '°C', 1)],
                      ['Wind speed', `${formatValue(num(w.wind_speed_kmh), 'km/h')} (${formatValue(num(w.wind_speed_ms), 'm/s', 1)})`],
                      ['Air pressure', formatValue(num(w.air_pressure_hpa), 'hPa', 1)],
                      ['Relative humidity', formatValue(num(w.relative_humidity_pct), '%')]].map(([k, v]) => (
                      <TableRow key={k}><TableCell sx={{ pl: 0 }}>{k}</TableCell><TableCell align="right" sx={{ fontFeatureSettings: '"tnum" 1' }}>{v}</TableCell><TableCell sx={{ pr: 0 }}>{PROVENANCE[wKind]?.label ?? wKind}</TableCell></TableRow>
                    ))}
                    <TableRow>
                      <TableCell sx={{ pl: 0 }}>Wind chill (JAG/TI formula)</TableCell>
                      <TableCell align="right" sx={{ fontFeatureSettings: '"tnum" 1' }}>{formatValue(num(d.risk?.wind_chill_c), '°C', 1)}</TableCell>
                      <TableCell sx={{ pr: 0 }}>Model-derived from the values above</TableCell>
                    </TableRow>
                  </TableBody>
                </Table>
              )}
            </Section>

            <Section n={3} title="Power and heating">
              {station !== activeStation ? (
                <Typography variant="body2" sx={{ color: 'text.secondary' }}>Live telemetry is loaded for {stationMeta(activeStation).name} only. Switch station in the top bar to include these figures.</Typography>
              ) : (
                <Facts rows={[
                  ['Generator output', formatValue(num(gen.gen_power), 'kW', 1)],
                  ['Fuel burn', `${formatValue(num(gen.gen_fuel_rate), 'L/h', 1)}${specific != null ? ` (${formatNumber(specific, 3)} L/kWh)` : ''}`],
                  ['Coolant temperature', `${formatValue(num(gen.gen_temp), '°C', 1)} (warning above ${formatValue(num(d.config?.thresholds?.gen_temp?.high?.warning), '°C')})`],
                  ['Living quarters', formatValue(num(lq.lq_temp), '°C', 1)],
                  ['Provenance', PROVENANCE[equipKind]?.label ?? equipKind],
                ]} />
              )}
            </Section>

            <Section n={4} title="Supplies (operator-entered ledger)">
              {!d.logistics ? <Typography variant="body2" sx={{ color: 'text.secondary' }}>Unavailable ({d.errors.logistics || 'no items'}).</Typography> : (
                <ScrollX label="Supplies, scrollable">
                  <Table size="small" aria-label="Supplies" sx={{ minWidth: 520 }}>
                    <TableHead><TableRow><TableCell sx={{ pl: 0 }}>Item</TableCell><TableCell align="right">Stock</TableCell><TableCell align="right">Daily use</TableCell><TableCell align="right">Autonomy</TableCell><TableCell sx={{ pr: 0 }}>Reorder</TableCell></TableRow></TableHead>
                    <TableBody>
                      {d.logistics.map((i) => (
                        <TableRow key={i.id}>
                          <TableCell sx={{ pl: 0 }}>{i.name}</TableCell>
                          <TableCell align="right" sx={{ fontFeatureSettings: '"tnum" 1' }}>{formatValue(i.current, i.unit)}</TableCell>
                          <TableCell align="right" sx={{ fontFeatureSettings: '"tnum" 1' }}>{formatValue(i.dailyUse, `${i.unit}/day`, i.dailyUse < 10 ? 1 : 0)}</TableCell>
                          <TableCell align="right" sx={{ fontFeatureSettings: '"tnum" 1' }}>{i.daysRemaining == null ? 'no daily use' : `${formatNumber(i.daysRemaining)} days`}</TableCell>
                          <TableCell sx={{ pr: 0 }}>{i.isLow ? 'At or below reorder level' : 'Above reorder level'}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </ScrollX>
              )}
            </Section>

            <Section n={5} title="Rule-based risk assessment">
              {!d.risk ? <Typography variant="body2" sx={{ color: 'text.secondary' }}>Unavailable ({d.errors.risk || 'no data'}).</Typography> : (
                <>
                  <Typography variant="body2">Risk index {formatNumber(d.risk.risk_score)} / 100 ({d.risk.overall_health}). Rules evaluated on the latest stored observations.</Typography>
                  {d.risk.identified_risks?.length ? (
                    <Stack component="ul" sx={{ m: 0, mt: 2, pl: 4, gap: 1.5, typography: 'body2' }}>
                      {d.risk.identified_risks.map((r) => (
                        <li key={r.risk_id}><b>{r.affected_system}</b> ({r.risk_level}): {r.reason} Suggested action: {r.recommended_action}</li>
                      ))}
                    </Stack>
                  ) : <Typography variant="body2" sx={{ color: 'text.secondary', mt: 1 }}>No rule triggered.</Typography>}
                  <Typography variant="caption" component="p" sx={{ color: 'text.secondary', mt: 2 }}>
                    Wind-chill risk bands: {FROSTBITE_SOURCE.short}. {d.risk.provenance}.
                  </Typography>
                </>
              )}
            </Section>

            <Section n={6} title="Review">
              <Box sx={{ display: 'grid', gap: 6, gridTemplateColumns: { xs: 'minmax(0, 1fr)', sm: 'repeat(2, minmax(0, 1fr))' }, fontSize: 14 }}>
                <Box>
                  <Typography variant="caption" sx={{ color: 'text.secondary' }}>Prepared by</Typography>
                  <Typography variant="body2">Aurora digital twin (prototype, generated automatically). Values are labelled by provenance and not verified by NCPOR.</Typography>
                </Box>
                <Box>
                  <Typography variant="caption" sx={{ color: 'text.secondary' }}>Station leader</Typography>
                  <Divider sx={{ mt: 8, mb: 1 }} />
                  <Typography variant="caption" sx={{ color: 'text.secondary' }}>Signature and date</Typography>
                </Box>
              </Box>
            </Section>
          </>
        )}
      </Card>
    </Box>
  );
}
