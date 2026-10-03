/* Aurora assistant — "Highlighted by Aurora": the components and dependency chain the
   assistant highlighted, shown at the top of any page, with Clear. The Infrastructure
   tiles and the dependency map outline the same components. */
import { Box, Button, Stack, Typography } from '@mui/material';
import { buildingName } from './actions';
import { stationMeta } from '../data/stationConfig';

export default function HighlightStrip({ highlight, activeStation, activeModule, onOpenMap, onClear }) {
  if (!highlight?.ids?.length) return null;
  const st = highlight.station;
  const other = st !== activeStation;
  const from = highlight.chainFrom;
  const rest = highlight.ids.filter((b) => b !== from);
  return (
    <Box role="status" data-testid="highlight-strip" data-ids={highlight.ids.join(' ')}
      sx={(t) => ({ mx: { xs: 4, sm: 6 }, mt: 3, mb: 0, px: 4, py: 2.5, borderRadius: '10px', border: `1px solid ${t.vars.palette.primary.main}`,
        bgcolor: t.vars.palette.aurora.surfaceRaised, display: 'flex', alignItems: 'center', gap: 3, flexWrap: 'wrap' })}>
      <Typography variant="label" component="p" sx={{ m: 0, color: 'primary.main', fontWeight: 600 }}>Highlighted by Aurora</Typography>
      <Typography variant="body2" sx={{ flex: 1, minWidth: 200 }}>
        {from ? <><strong>{buildingName(st, from)}</strong>{rest.length ? ' → ' : ''}</> : null}
        {rest.map((b) => buildingName(st, b)).join(', ')}
        {other ? ` (at ${stationMeta(st).name})` : ''}
      </Typography>
      <Stack direction="row" sx={{ gap: 1 }}>
        {activeModule !== 'infrastructure' && !other && <Button size="small" onClick={onOpenMap}>Dependency map</Button>}
        <Button size="small" onClick={onClear} data-testid="highlight-clear">Clear</Button>
      </Stack>
    </Box>
  );
}
