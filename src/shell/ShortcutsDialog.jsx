/* Aurora — the help dialog ("?"): the product tour and the keyboard shortcuts.
   Loaded on first open. */
import { Box, Button, Dialog, DialogContent, DialogTitle, IconButton, Stack, Table, TableBody, TableCell, TableRow, Typography } from '@mui/material';
import TourOutlined from '@mui/icons-material/TourOutlined';
import CloseOutlined from '@mui/icons-material/CloseOutlined';
import Keys from '../ui/Keys';
import { MODULES, NAV_ACTIONS } from './navigation';

const MOD = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';

export default function ShortcutsDialog({ open, onClose, onStartTour }) {
  const rows = [
    [[MOD, 'K'], 'Command palette'],
    [['?'], 'This help'],
    [['Esc'], 'Close a dialog, drawer or menu'],
    [['V'], 'Hold to talk to Aurora (release to send)'],
    ...Object.values(MODULES).map((m) => [['g', m.key], `Go to ${m.label}`]),
    [['g', NAV_ACTIONS.twinInspector.key], 'Open the Twin inspector'],
    [['A'], 'Overview 3D: Station / Antarctica view'],
    [['['], 'Overview 3D: previous station'],
    [[']'], 'Overview 3D: next station'],
  ];
  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth aria-labelledby="shortcuts-title" slotProps={{ paper: { 'data-testid': 'shortcuts-dialog' } }}>
      <DialogTitle id="shortcuts-title" sx={{ display: 'flex', alignItems: 'center' }}>
        <Stack sx={{ flex: 1 }}>Help</Stack>
        <IconButton onClick={onClose} aria-label="Close help"><CloseOutlined /></IconButton>
      </DialogTitle>
      <DialogContent>
        {onStartTour && (
          <Box sx={{ p: 4, mb: 4, borderRadius: '10px', bgcolor: 'aurora.surfaceRaised', display: 'flex', gap: 3, alignItems: 'center', flexWrap: 'wrap' }}>
            <Typography variant="body2" sx={{ flex: 1, minWidth: 180 }}>New here? A 12-step tour of the stations, data sources, alerts and pages.</Typography>
            <Button variant="contained" size="small" startIcon={<TourOutlined />} onClick={() => { onClose(); onStartTour(); }} data-testid="shortcuts-start-tour">Start the tour</Button>
          </Box>
        )}
        <Typography variant="h3" component="h3" sx={{ mb: 1 }}>Keyboard shortcuts</Typography>
        <Typography variant="body2" sx={{ color: 'text.secondary', mb: 2 }}>Shortcuts are off while you type in a field. For “g” sequences, press g, then the letter.</Typography>
        <Table size="small" aria-label="Keyboard shortcuts">
          <TableBody>
            {rows.map(([keys, what]) => (
              <TableRow key={what}><TableCell sx={{ pl: 0, width: 110 }}><Keys keys={keys} /><span style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>{keys.join(' then ')}</span></TableCell><TableCell sx={{ pr: 0 }}>{what}</TableCell></TableRow>
            ))}
          </TableBody>
        </Table>
      </DialogContent>
    </Dialog>
  );
}
