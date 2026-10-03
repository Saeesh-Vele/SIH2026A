/* ═══════════════════════════════════════════════════════════════
   Aurora — alert centre (rollout 1B, checkpoint 3). Replaces AlertFeed.

   Active: open alerts nobody has acknowledged. Acknowledged: open alerts an
   operator has seen; they stay until the reading has been normal for the
   alert engine's resolve ticks. History: GET /alerts/history (resolved and
   open, newest first). All from the backend alert engine; browser-demo alerts
   have no id and cannot be acknowledged. Acknowledging asks first and records
   the operator name.
   ═══════════════════════════════════════════════════════════════ */
import { useEffect, useState } from 'react';
import { Box, ButtonBase, Drawer, IconButton, Stack, Tab, Tabs, Typography } from '@mui/material';
import CloseOutlined from '@mui/icons-material/CloseOutlined';
import { apiGet, describeApiError } from '../services/api';
import { useNow } from '../hooks/useNow';
import { getOperatorName } from '../services/operator';
import { formatDateTimeIST, formatRelative, formatValue } from '../lib/format';
import { EmptyState, ErrorState, LoadingBlock } from '../ui/States';
import { StatusChip } from '../ui/Status';
import WriteButton from '../ui/WriteButton';
import { SandboxNotice, SandboxTag } from '../ui/Sandbox';
import { useConfirm, useToast } from '../ui/feedbackContext';

const levelStatus = (l) => (l === 'critical' ? 'critical' : 'warning');

function AlertItem({ a, now, onOpen, action }) {
  return (
    <Box component="li" data-testid="alert-card" data-alert-id={a.id} sx={{ borderRadius: '10px', bgcolor: 'aurora.surfaceRaised', overflow: 'hidden' }}>
      <ButtonBase onClick={() => onOpen(a.buildingId)} sx={{ display: 'block', width: '100%', textAlign: 'left', p: 4, '&:hover': { bgcolor: 'action.hover' } }}
        aria-label={`${a.buildingName}: ${a.message}. Open building`}>
        <Stack direction="row" sx={{ gap: 2, alignItems: 'center' }}>
          <StatusChip status={levelStatus(a.level)} />
          <Typography sx={{ fontWeight: 600, fontSize: 14, flex: 1, minWidth: 0 }}>{a.buildingName || a.buildingId}</Typography>
          <SandboxTag show={a.sandboxThreshold} label="Your threshold" />
          <Typography variant="caption" sx={{ color: 'text.secondary' }}>{formatRelative(a.timestamp, now)}</Typography>
        </Stack>
        <Typography variant="body2" sx={{ mt: 1.5 }}>{a.message}</Typography>
        {a.sensor && (
          <Typography variant="caption" component="p" sx={{ color: 'text.secondary', m: 0 }}>
            {a.sensor}: {formatValue(a.value, a.unit, 1)} · threshold {formatValue(a.threshold, a.unit, 1)} · raised {formatDateTimeIST(a.timestamp)}
          </Typography>
        )}
      </ButtonBase>
      {action && <Box sx={{ px: 4, pb: 3 }}>{action}</Box>}
    </Box>
  );
}

export default function AlertCentre({ open, onClose, alerts = [], onAlertClick, onAcknowledge, activeStation, canAcknowledge = true, initialTab = 'active' }) {
  const now = useNow(15000);
  const confirm = useConfirm();
  const toast = useToast();
  const [tab, setTab] = useState(initialTab);
  const [history, setHistory] = useState({ key: null, rows: null, error: null });
  const [pending, setPending] = useState(null);

  const sorted = [...alerts].sort((a, b) => (a.level !== b.level ? (a.level === 'critical' ? -1 : 1) : (b.timestamp || 0) - (a.timestamp || 0)));
  const active = sorted.filter((a) => !a.acknowledged);
  const acked = sorted.filter((a) => a.acknowledged);
  const hKey = `${activeStation}|${open}|${tab}`;

  useEffect(() => {
    if (!open || tab !== 'history') return undefined;
    let alive = true;
    apiGet(`/alerts/history?stationId=${activeStation}&limit=50`)
      .then((d) => { if (alive) setHistory({ key: hKey, rows: d.alerts || [], error: null }); })
      .catch((err) => {
        console.error('[Alerts] history failed', err);
        if (alive) setHistory({ key: hKey, rows: null, error: err });
      });
    return () => { alive = false; };
  }, [open, tab, activeStation, hKey]);
  const hist = history.key === hKey ? history : null;

  const openBuilding = (id) => { onAlertClick?.(id); onClose(); };

  async function acknowledge(a) {
    const ok = await confirm({
      title: 'Acknowledge this alert?',
      body: `${a.buildingName}: ${a.message} It is recorded as acknowledged by ${getOperatorName()} and stays listed until the reading is normal again.`,
      confirmLabel: 'Acknowledge',
    });
    if (!ok) return;
    setPending(a.id);
    const res = await onAcknowledge?.(a.id);
    setPending(null);
    toast(res?.ok ? { text: `Acknowledged: ${a.buildingName}.` } : { severity: 'error', text: `Acknowledge failed: ${res?.error || 'no response'}` });
  }

  const list = (items, emptyTitle, emptyText, withAck) => (items.length ? (
    <Stack component="ul" sx={{ m: 0, p: 0, listStyle: 'none', gap: 2 }}>
      {items.map((a) => (
        <AlertItem key={a.id || `${a.buildingId}-${a.sensor}`} a={a} now={now} onOpen={openBuilding}
          action={withAck ? (canAcknowledge && a.id ? (
            <WriteButton size="small" variant="outlined" onClick={() => acknowledge(a)} disabled={pending === a.id} data-testid="alert-ack-btn">
              {pending === a.id ? 'Acknowledging…' : 'Acknowledge'}
            </WriteButton>
          ) : <Typography variant="caption" sx={{ color: 'text.secondary' }}>Browser-demo alert: cannot be acknowledged</Typography>)
            : <Typography variant="caption" sx={{ color: 'text.secondary' }} data-testid="alert-acked">Acknowledged by {a.acknowledgedBy}{a.acknowledgedAt ? `, ${formatDateTimeIST(a.acknowledgedAt)}` : ''} <SandboxTag show={a.sandbox} sx={{ ml: 1 }} /></Typography>} />
      ))}
    </Stack>
  ) : <EmptyState title={emptyTitle} height={160}>{emptyText}</EmptyState>);

  return (
    <Drawer anchor="right" open={open} onClose={onClose}
      slotProps={{ paper: { sx: { width: { xs: '100%', sm: 440 }, borderRadius: { sm: '12px 0 0 12px' } }, 'data-testid': 'alert-drawer', role: 'dialog', 'aria-labelledby': 'alert-centre-title' } }}>
      <Box sx={{ px: 6, pt: 5, pb: 2 }}>
        <Stack direction="row" sx={{ alignItems: 'center', gap: 2 }}>
          <Typography id="alert-centre-title" component="h2" sx={{ fontSize: 20, fontWeight: 600, flex: 1 }}>Alert centre</Typography>
          <IconButton onClick={onClose} aria-label="Close alert centre"><CloseOutlined /></IconButton>
        </Stack>
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>
          {active.filter((a) => a.level === 'critical').length} critical · {active.filter((a) => a.level !== 'critical').length} warning unacknowledged
        </Typography>
        <SandboxNotice sx={{ mt: 3, mb: 0 }}>Acknowledging here is recorded for you only.</SandboxNotice>
      </Box>
      <Tabs value={tab} onChange={(_, v) => setTab(v)} variant="fullWidth" aria-label="Alert views" sx={{ px: 6 }}>
        <Tab value="active" label={`Active (${active.length})`} data-testid="alerts-tab-active" />
        <Tab value="acknowledged" label={`Acknowledged (${acked.length})`} data-testid="alerts-tab-acknowledged" />
        <Tab value="history" label="History" data-testid="alerts-tab-history" />
      </Tabs>
      <Box role="tabpanel" aria-label={tab} sx={{ flex: 1, overflowY: 'auto', px: 6, py: 4 }} tabIndex={0}>
        {tab === 'active' && list(active, 'No unacknowledged alerts', 'Every open alert has been seen, or every sensor is inside its thresholds.', true)}
        {tab === 'acknowledged' && list(acked, 'Nothing acknowledged and open', 'Acknowledged alerts stay here until the reading is normal again.', false)}
        {tab === 'history' && (!hist ? <LoadingBlock lines={6} /> : hist.error ? (
          <ErrorState>History unavailable: {describeApiError(hist.error)}</ErrorState>
        ) : !hist.rows.length ? <EmptyState title="No alerts recorded" height={160}>The alert engine has not raised an alert for this station.</EmptyState> : (
          <Stack component="ul" sx={{ m: 0, p: 0, listStyle: 'none', gap: 2 }}>
            {hist.rows.map((h) => (
              <Box component="li" key={h.id} data-testid="alert-history-row" sx={{ p: 4, borderRadius: '10px', bgcolor: 'aurora.surfaceRaised' }}>
                <Stack direction="row" sx={{ gap: 2, alignItems: 'center' }}>
                  <StatusChip status={levelStatus(h.peakLevel)} label={`Peak ${h.peakLevel}`} />
                  <Typography sx={{ fontWeight: 600, fontSize: 14, flex: 1 }}>{h.buildingName}</Typography>
                </Stack>
                <Typography variant="body2" sx={{ mt: 1.5 }}>{h.message}</Typography>
                <Typography variant="caption" component="p" sx={{ color: 'text.secondary', m: 0 }}>
                  Raised {formatDateTimeIST(h.raisedAt)} · {h.status}{h.resolvedAt ? ` ${formatDateTimeIST(h.resolvedAt)}` : ''}{h.acknowledgedBy ? ` · acknowledged by ${h.acknowledgedBy}` : ''}
                </Typography>
              </Box>
            ))}
          </Stack>
        ))}
      </Box>
    </Drawer>
  );
}
