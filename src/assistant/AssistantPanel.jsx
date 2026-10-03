/* ═══════════════════════════════════════════════════════════════
   Aurora assistant — the panel (v2 side sheet; a bottom sheet on phones).

   Non-modal on purpose: the page stays usable and visible while Aurora opens
   pages and highlights components (on wide screens the page makes room for it).
   Transcript with action chips (Undo where it makes sense), live captions while
   listening, a mic button (or hold V), a text box that always works, mute and
   settings. Voice input falls back to text where the browser has no speech
   recognition, and the privacy note says where browser speech recognition sends audio.
   ═══════════════════════════════════════════════════════════════ */
import { useEffect, useRef, useState } from 'react';
import {
  Alert, Box, Button, Chip, Collapse, FormControlLabel, IconButton, MenuItem, Paper, Slider, Stack, Switch, TextField, Typography,
} from '@mui/material';
import CloseOutlined from '@mui/icons-material/CloseOutlined';
import MicNoneOutlined from '@mui/icons-material/MicNoneOutlined';
import MicOffOutlined from '@mui/icons-material/MicOffOutlined';
import SendOutlined from '@mui/icons-material/SendOutlined';
import SettingsOutlined from '@mui/icons-material/SettingsOutlined';
import StopCircleOutlined from '@mui/icons-material/StopCircleOutlined';
import UndoOutlined from '@mui/icons-material/UndoOutlined';
import VolumeOffOutlined from '@mui/icons-material/VolumeOffOutlined';
import VolumeUpOutlined from '@mui/icons-material/VolumeUpOutlined';
import { hasHindiVoice } from './speech';
import { suggestLabel } from './actions';
import IncidentCard from './IncidentCard';

export const PANEL_WIDTH = 400;
const EXAMPLES = [
  'Open the energy grid for Bharati',
  "What's the fuel situation at Maitri?",
  'Show me what depends on the generator',
  "What happens if there's a blizzard at Maitri?",
  'Explain the current anomaly',
  'Start the blizzard story',
];

function Message({ e, onUndo, onSuggestion, stationId }) {
  const [more, setMore] = useState(false);
  const mine = e.role === 'user';
  return (
    <Box component="li" sx={{ display: 'flex', flexDirection: 'column', alignItems: mine ? 'flex-end' : 'flex-start', gap: 1 }}
      data-testid={mine ? 'msg-user' : 'msg-aurora'} data-kind={e.kind || undefined}>
      <Box sx={(t) => ({
        maxWidth: '92%', px: 3, py: 2, borderRadius: mine ? '12px 12px 4px 12px' : '12px 12px 12px 4px', fontSize: 14, lineHeight: 1.5,
        bgcolor: mine ? t.vars.palette.primary.main : e.error ? t.vars.palette.status.criticalTint : t.vars.palette.aurora.surfaceRaised,
        color: mine ? t.vars.palette.primary.contrastText : t.vars.palette.text.primary,
        borderLeft: !mine && (e.kind === 'incident' || e.kind === 'update') ? `3px solid ${t.vars.palette.status.critical}` : undefined,
      })}>
        {mine && e.via === 'voice' && <Typography component="span" variant="caption" sx={{ display: 'block', opacity: 0.8 }}>Said</Typography>}
        {e.text}
        {e.resolved && <Typography component="span" variant="caption" sx={{ display: 'block', mt: 0.5, fontWeight: 600 }}>{e.resolved}</Typography>}
        {e.note && <Typography component="span" variant="caption" sx={{ display: 'block', mt: 0.5, color: 'text.secondary' }}>{e.note}</Typography>}
      </Box>
      {!mine && (e.notice || e.mode === 'llm' || e.grounding?.ok === false) && (
        <Typography variant="caption" sx={{ color: 'text.secondary' }} data-testid="msg-mode">
          {e.notice || (e.mode === 'llm' ? 'Phrased by the LLM from station data; numbers checked against it' : null)}
          {e.grounding?.ok === false ? 'Answered from station data (the AI phrasing quoted numbers not in the data)' : null}
        </Typography>
      )}
      {e.chips?.length > 0 && (
        <Stack direction="row" sx={{ gap: 1, flexWrap: 'wrap' }}>
          {e.chips.map((c) => (
            <Chip key={c.id} size="small" variant="outlined" data-testid="action-chip" data-undone={c.undone || undefined}
              color={c.refused ? 'default' : 'primary'} label={c.undone ? `${c.label} (undone)` : c.label}
              onDelete={c.undo && !c.undone ? () => onUndo(e.id, c.id) : undefined}
              deleteIcon={c.undo && !c.undone ? <UndoOutlined aria-label={`Undo: ${c.label}`} /> : undefined} />
          ))}
        </Stack>
      )}
      {e.suggestions?.length > 0 && (
        <Stack direction="row" sx={{ gap: 1, flexWrap: 'wrap' }}>
          {e.suggestions.map((a) => (
            <Button key={JSON.stringify(a)} size="small" variant="outlined" onClick={() => onSuggestion(e.id, a)} data-testid="suggestion">
              {suggestLabel(a, stationId)}
            </Button>
          ))}
        </Stack>
      )}
      {e.detail?.length > 0 && (
        <>
          <Button size="small" sx={{ px: 0, minWidth: 0 }} onClick={() => setMore((v) => !v)} aria-expanded={more}>{more ? 'Less' : 'Details'}</Button>
          <Collapse in={more} unmountOnExit>
            <Box component="ul" sx={{ m: 0, pl: 4, fontSize: 13, color: 'text.secondary' }} data-testid="msg-detail">
              {e.detail.map((d) => <li key={d}>{d}</li>)}
            </Box>
            {e.sources?.length > 0 && <Typography variant="caption" sx={{ color: 'text.secondary' }}>Sources: {e.sources.join(', ').replace(/_/g, ' ')}</Typography>}
          </Collapse>
        </>
      )}
    </Box>
  );
}

export default function AssistantPanel({
  open, isPhone, onClose, entries, busy, listening, interim, speaking, support, prefs, setPrefs, status, micError,
  onSend, onMic, onUndo, onSuggestion, onStop, pendingConfirm, incident, book, queued, onFocusIncident, onToggleStep,
  onIncidentControl, onShowChain, snoozedUntil, now, stationName, stationId, ctx, draft,
}) {
  const [text, setText] = useState(draft || '');
  const [settings, setSettings] = useState(false);
  const listRef = useRef(null);
  const inputRef = useRef(null);
  const cardRef = useRef(null);
  const titleId = 'aurora-panel-title';

  useEffect(() => { if (draft) setText(draft); }, [draft]);
  useEffect(() => { if (open) setTimeout(() => inputRef.current?.focus(), 50); }, [open]);
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries.length, interim]);
  // A new incident: show its card from the top.
  useEffect(() => { if (cardRef.current) cardRef.current.scrollTop = 0; }, [incident?.key]);

  const send = () => {
    const t = text.trim();
    if (!t || busy) return;
    onSend(t);
    setText('');
  };
  const voiceIn = support.recognition;
  const hindi = support.synthesis && hasHindiVoice();
  const offline = status && status.llmAvailable === false;

  if (!open) return null;
  return (
    <Paper
      role="dialog" aria-modal="false" aria-labelledby={titleId} data-testid="assistant-panel" elevation={8}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }}
      sx={(t) => ({
        position: 'fixed', zIndex: 1200, display: 'flex', flexDirection: 'column', overflow: 'hidden',
        bgcolor: t.vars.palette.background.paper, border: `1px solid ${t.vars.palette.divider}`,
        ...(isPhone
          ? { left: 0, right: 0, bottom: 0, height: '62vh', borderRadius: '16px 16px 0 0' }
          : { top: 64, right: 0, bottom: 0, width: PANEL_WIDTH, borderRadius: '12px 0 0 12px' }),
      })}
    >
      <Box sx={{ px: 5, pt: 4, pb: 2, borderBottom: 1, borderColor: 'divider' }}>
        <Stack direction="row" sx={{ alignItems: 'center', gap: 1 }}>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography id={titleId} component="h2" sx={{ fontSize: 18, fontWeight: 600 }}>Aurora</Typography>
            <Typography variant="caption" sx={{ color: 'text.secondary', display: isPhone ? 'none' : 'block' }}>Operator assistant · answers from {stationName}'s station data</Typography>
          </Box>
          {speaking && <IconButton onClick={onStop} aria-label="Stop speaking" data-testid="assistant-stop"><StopCircleOutlined /></IconButton>}
          <IconButton onClick={() => setPrefs({ voice: !prefs.voice })} aria-pressed={!prefs.voice} data-testid="assistant-mute"
            aria-label={prefs.voice ? 'Mute Aurora' : 'Unmute Aurora'}>
            {prefs.voice ? <VolumeUpOutlined /> : <VolumeOffOutlined />}
          </IconButton>
          <IconButton onClick={() => setSettings((v) => !v)} aria-expanded={settings} aria-label="Assistant settings" data-testid="assistant-settings"><SettingsOutlined /></IconButton>
          <IconButton onClick={onClose} aria-label="Close Aurora" data-testid="assistant-close"><CloseOutlined /></IconButton>
        </Stack>
        <Collapse in={settings} unmountOnExit>
          <Stack sx={{ py: 2, gap: 0.5 }} data-testid="assistant-settings-panel">
            <FormControlLabel control={<Switch size="small" checked={prefs.voice} onChange={(e) => setPrefs({ voice: e.target.checked })} />} label="Speak replies" />
            <FormControlLabel control={<Switch size="small" checked={prefs.autoNavigate} onChange={(e) => setPrefs({ autoNavigate: e.target.checked })} />} label="Open pages automatically" />
            <FormControlLabel control={<Switch size="small" checked={prefs.announceAll} onChange={(e) => setPrefs({ announceAll: e.target.checked })} data-testid="assistant-announce-all" />}
              label="Announce all incidents (not only the ones you start)" />
            <FormControlLabel control={<Switch size="small" checked={prefs.conversation} disabled={!voiceIn} onChange={(e) => setPrefs({ conversation: e.target.checked })} />}
              label="Conversation mode (keep listening)" />
            <Stack direction="row" sx={{ alignItems: 'center', gap: 3, pr: 2 }}>
              <Typography variant="body2" id="aurora-rate" sx={{ whiteSpace: 'nowrap' }}>Speaking rate</Typography>
              <Slider size="small" min={0.7} max={1.5} step={0.1} value={prefs.rate} onChange={(_, v) => setPrefs({ rate: v })}
                aria-labelledby="aurora-rate" valueLabelDisplay="auto" />
            </Stack>
            <TextField select size="small" label="Language" value={prefs.lang} onChange={(e) => setPrefs({ lang: e.target.value })} sx={{ mt: 1, maxWidth: 220 }}
              helperText={hindi ? 'Hindi answers need the LLM; data-only answers stay in English.' : 'Hindi voice output is not available in this browser.'}>
              <MenuItem value="en">English</MenuItem>
              <MenuItem value="hi">हिन्दी (Hindi)</MenuItem>
            </TextField>
          </Stack>
        </Collapse>
        {offline && <Typography variant="caption" component="p" sx={{ color: 'text.secondary', mt: 1 }} data-testid="assistant-offline">Answering from station data only{status.reason ? ` (${status.reason})` : ''}.</Typography>}
      </Box>

      {incident && book && (
        <Box ref={cardRef} sx={{ flex: 'none', maxHeight: isPhone ? '58%' : '62%', overflowY: 'auto', px: 4, py: 3, borderBottom: 1, borderColor: 'divider' }}
          tabIndex={0} role="region" aria-label="Current incident">
          <IncidentCard incident={incident} book={book} queue={queued} ctx={ctx} onToggleStep={onToggleStep}
            onControl={onIncidentControl} onShowChain={onShowChain} onFocus={onFocusIncident} snoozedUntil={snoozedUntil} now={now} />
        </Box>
      )}
      <Box ref={listRef} sx={{ flex: 1, minHeight: 96, overflowY: 'auto', px: 5, py: 3 }} tabIndex={0} role="region" aria-label="Conversation with Aurora">
        {entries.length === 0 && !incident && (
          <Box data-testid="assistant-empty">
            <Typography variant="body2" sx={{ color: 'text.secondary', mb: 2 }}>
              Ask about the station or tell me what to open. I answer only from the station's data, and say so when it doesn't have the answer.
            </Typography>
            <Stack direction="row" sx={{ gap: 1, flexWrap: 'wrap' }}>
              {EXAMPLES.map((x) => <Chip key={x} label={x} size="small" variant="outlined" clickable onClick={() => onSend(x)} />)}
            </Stack>
          </Box>
        )}
        <Stack component="ol" aria-live="polite" sx={{ m: 0, p: 0, listStyle: 'none', gap: 3 }} data-testid="assistant-transcript">
          {entries.map((e) => (
            <Message key={e.id} e={e} onUndo={onUndo} onSuggestion={onSuggestion} stationId={stationId} />
          ))}
        </Stack>
        {(busy || (listening && interim)) && (
          <Typography variant="body2" sx={{ color: 'text.secondary', mt: 3, fontStyle: 'italic' }} role="status" data-testid="assistant-caption">
            {listening && interim ? `“${interim}”` : 'Thinking…'}
          </Typography>
        )}
      </Box>

      <Box sx={{ px: 4, pt: 2, pb: 3, borderTop: 1, borderColor: 'divider' }}>
        {pendingConfirm && <Alert severity="info" icon={false} sx={{ mb: 2, py: 0 }}>Waiting for your answer: say “yes” or “no”, or use the dialog.</Alert>}
        {micError && <Alert severity="warning" icon={false} sx={{ mb: 2, py: 0 }}>{micError}</Alert>}
        <Stack direction="row" sx={{ gap: 1, alignItems: 'flex-end' }} component="form" onSubmit={(e) => { e.preventDefault(); send(); }}>
          <IconButton onClick={onMic} disabled={!voiceIn} aria-pressed={listening} data-testid="assistant-mic"
            aria-label={!voiceIn ? 'Voice input is not supported in this browser' : listening ? 'Stop listening' : 'Speak to Aurora'}
            sx={(t) => (listening ? { bgcolor: t.vars.palette.status.criticalTint, color: t.vars.palette.status.critical } : {})}>
            {voiceIn ? <MicNoneOutlined /> : <MicOffOutlined />}
          </IconButton>
          <TextField inputRef={inputRef} fullWidth size="small" multiline maxRows={3} value={text} placeholder={listening ? 'Listening…' : 'Ask Aurora or give a command'}
            onChange={(e) => setText(e.target.value.slice(0, 500))}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
            slotProps={{ htmlInput: { 'aria-label': 'Message to Aurora', 'data-testid': 'assistant-input', maxLength: 500 } }} />
          <IconButton type="submit" disabled={!text.trim() || busy} aria-label="Send" data-testid="assistant-send"><SendOutlined /></IconButton>
        </Stack>
        <Typography variant="caption" component="p" sx={{ color: 'text.secondary', mt: 1.5 }} data-testid="assistant-privacy">
          {voiceIn
            ? <>{isPhone ? 'Tap the mic to talk.' : <>Hold <Box component="kbd" sx={{ fontFamily: 'inherit', fontWeight: 600 }}>V</Box> or tap the mic to talk.</>} Voice input uses your browser's speech recognition, which may send audio to the browser vendor.</>
            : 'Voice input is not supported in this browser, so type instead. Replies can still be spoken.'}
        </Typography>
      </Box>
    </Paper>
  );
}
