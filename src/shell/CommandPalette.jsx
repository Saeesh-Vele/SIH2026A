/* ═══════════════════════════════════════════════════════════════
   Aurora — command palette (⌘K / Ctrl+K). Loaded on first open.
   A combobox over every page, station, drawer and action, with each one's
   shortcut. ↑ ↓ move, Enter runs, Esc closes. Matching is by words: every
   typed word must start a word of the command (or its keywords).
   ═══════════════════════════════════════════════════════════════ */
import { useMemo, useState } from 'react';
import { Box, Dialog, InputAdornment, InputBase, Stack, Typography } from '@mui/material';
import SearchOutlined from '@mui/icons-material/SearchOutlined';
import { matchCommand } from './commandMatch';
import Keys from '../ui/Keys';

export default function CommandPalette({ open, onClose, commands, onAsk }) {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  // Anything typed can also go to Aurora, the assistant (last, so commands win on Enter).
  const items = useMemo(() => {
    const found = commands.filter((c) => matchCommand(c, query));
    const q = query.trim();
    return onAsk && q.length > 2
      ? [...found, { id: 'ask-aurora', group: 'Aurora', label: `Ask Aurora: “${q}”`, run: () => onAsk(q) }]
      : found;
  }, [commands, query, onAsk]);
  const sel = Math.min(index, Math.max(items.length - 1, 0));

  const run = (cmd) => { onClose(); setQuery(''); setIndex(0); cmd.run(); };
  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setIndex((i) => Math.min(i + 1, items.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setIndex((i) => Math.max(i - 1, 0)); }
    else if (e.key === 'Enter' && items[sel]) { e.preventDefault(); run(items[sel]); }
  };
  let lastGroup = null;

  return (
    <Dialog open={open} onClose={() => { onClose(); setQuery(''); setIndex(0); }} fullWidth maxWidth="sm"
      slotProps={{ paper: { sx: { alignSelf: 'flex-start', mt: { xs: 2, sm: '12vh' } }, 'data-testid': 'command-palette', 'aria-label': 'Command palette' } }}>
      <InputBase autoFocus fullWidth value={query} placeholder="Go to a page, switch station, run an action…"
        onChange={(e) => { setQuery(e.target.value); setIndex(0); }} onKeyDown={onKeyDown}
        startAdornment={<InputAdornment position="start"><SearchOutlined /></InputAdornment>}
        inputProps={{
          role: 'combobox', 'aria-expanded': true, 'aria-controls': 'palette-list', 'aria-autocomplete': 'list',
          'aria-activedescendant': items[sel] ? `cmd-${items[sel].id}` : undefined, 'aria-label': 'Search commands', 'data-testid': 'palette-input',
        }}
        sx={{ px: 4, py: 3, fontSize: 16, borderBottom: 1, borderColor: 'divider' }} />
      <Box component="ul" id="palette-list" role="listbox" aria-label="Commands" sx={{ m: 0, p: 2, listStyle: 'none', maxHeight: '52vh', overflowY: 'auto' }}>
        {!items.length && <Typography component="li" variant="body2" sx={{ p: 3, color: 'text.secondary' }}>No command matches “{query}”.</Typography>}
        {items.map((c, i) => {
          const header = c.group !== lastGroup;
          lastGroup = c.group;
          return (
            <Box component="li" key={c.id} role="presentation">
              {header && <Typography variant="overline" component="div" sx={{ px: 3, pt: i ? 2 : 0, color: 'text.secondary' }}>{c.group}</Typography>}
              <Stack id={`cmd-${c.id}`} role="option" aria-selected={i === sel} direction="row" data-testid={`cmd-${c.id}`}
                onClick={() => run(c)} onMouseMove={() => setIndex(i)}
                sx={(t) => ({ px: 3, py: 2, gap: 2, alignItems: 'center', borderRadius: '8px', cursor: 'pointer', bgcolor: i === sel ? t.vars.palette.aurora.accentTint : 'transparent' })}>
                <Typography sx={{ flex: 1, fontSize: 14 }}>{c.label}</Typography>
                {c.keys && <Keys keys={c.keys} />}
              </Stack>
            </Box>
          );
        })}
      </Box>
    </Dialog>
  );
}
