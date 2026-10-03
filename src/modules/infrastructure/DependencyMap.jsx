/* ═══════════════════════════════════════════════════════════════
   Aurora — dependency map (rollout 1B). Replaces the legacy DependencyGraph.

   Nodes and edges come from station_config.json. The layout is computed, not
   hand-placed: each building's column is its depth in the dependency DAG
   (fuel store → generator → loads → buildings they serve), left to right; on
   phones it keeps its natural size and scrolls sideways. Relations are told apart by line
   style (never by status colour); status colours mark only buildings with an
   active alert and the edges on a cascade chain from the backend.

   Every node is a keyboard button that opens the building panel, and the same
   information is available as a plain list for screen readers and phones.
   ═══════════════════════════════════════════════════════════════ */
import { useMemo, useState } from 'react';
import { Box, Button, Collapse, Stack, Table, TableBody, TableCell, TableHead, TableRow, Typography, useMediaQuery } from '@mui/material';
import { useTheme } from '@mui/material/styles';
import { buildingList, dependencyEdges } from '../../data/stationConfig';
import { ChartLegend } from '../../ui/ChartParts';
import { STATUS_LABEL } from '../../ui/statusLabels';
import { useChartTheme } from '../../theme/chartTheme';
import { layoutDepths } from '../../lib/graphLayout';

const RELATION_DASH = { powers: null, fuels: '7 4', heats: '2 4', supplies: '9 3 2 3' };
const NODE_W = 156;
const NODE_H = 52;

function useLayout(stationId) {
  return useMemo(() => {
    const buildings = buildingList(stationId);
    const edges = dependencyEdges(stationId);
    const depth = layoutDepths(buildings.map((b) => b.id), edges);
    const cols = Math.max(...Object.values(depth)) + 1;
    const byCol = Array.from({ length: cols }, () => []);
    buildings.forEach((b) => byCol[depth[b.id]].push(b));
    const rows = Math.max(...byCol.map((c) => c.length));
    const colGap = 210;
    const rowGap = 76;
    const pos = {};
    byCol.forEach((col, c) => col.forEach((b, r) => {
      const offset = ((rows - col.length) * rowGap) / 2;    // centre short columns
      pos[b.id] = { x: c * colGap, y: offset + r * rowGap };
    }));
    return { buildings, edges, pos, width: (cols - 1) * colGap + NODE_W, height: (rows - 1) * rowGap + NODE_H };
  }, [stationId]);
}

function edgePath(a, b) {
  const x1 = a.x + NODE_W; const y1 = a.y + NODE_H / 2; const x2 = b.x - 6; const y2 = b.y + NODE_H / 2;
  const mx = (x1 + x2) / 2;
  return `M${x1} ${y1}C${mx} ${y1} ${mx} ${y2} ${x2} ${y2}`;
}

export default function DependencyMap({ stationId, alerts = {}, dependencyAlerts = [], onOpenBuilding, highlight = null }) {
  const theme = useTheme();
  // Phones get the same left-to-right map at its natural size, scrolled sideways: scaling it
  // down to 360 px made the labels unreadable. The list below carries the same information.
  const narrow = useMediaQuery(theme.breakpoints.down('sm'), { noSsr: true });
  const chart = useChartTheme();
  const { buildings, edges, pos, width, height } = useLayout(stationId);
  const [focus, setFocus] = useState(null);
  const [showList, setShowList] = useState(false);
  const names = Object.fromEntries(buildings.map((b) => [b.id, b.name]));

  // Edges on a cascade chain, with the chain's worst severity.
  const cascade = new Map();
  dependencyAlerts.forEach((d) => {
    const chain = d.chain?.length ? d.chain : [d.sourceBuilding, d.affectedBuilding];
    for (let i = 0; i < chain.length - 1; i += 1) {
      const k = `${chain[i]}>${chain[i + 1]}`;
      if (cascade.get(k) !== 'critical') cascade.set(k, d.severity === 'critical' ? 'critical' : 'warning');
    }
  });
  const levelOf = (id) => (alerts[id] === 'critical' || alerts[id] === 'warning' ? alerts[id] : 'normal');
  // Aurora's highlight: the components, and (for a dependency chain) the edges between them.
  const lit = new Set(highlight?.ids || []);
  const litEdge = (e) => Boolean(highlight?.chainFrom) && lit.has(e.source) && lit.has(e.target) && e.target !== highlight.chainFrom;
  const relations = [...new Set(edges.map((e) => e.relation))];

  return (
    <Box data-testid="dependency-map">
      <ChartLegend items={[
        ...relations.map((r) => ({ label: r, color: chart.labelFill, width: 1.5, dash: RELATION_DASH[r] ?? undefined })),
        { label: 'cascade risk', color: chart.status.warning, width: 2 },
        ...(lit.size ? [{ label: 'highlighted by Aurora', color: chart.accent, width: 2, dash: '5 3' }] : []),
      ]} />
      {narrow && <Typography variant="caption" component="p" sx={{ color: 'text.secondary', m: 0 }}>Scroll sideways to see the whole map.</Typography>}
      <Box sx={{ overflowX: 'auto', py: 1 }} tabIndex={narrow ? 0 : undefined} role={narrow ? 'region' : undefined} aria-label={narrow ? 'Dependency map, scrollable' : undefined}>
        <Box
          component="svg"
          viewBox={`-8 -8 ${width + 16} ${height + 16}`}
          role="group"
          aria-label={`Dependency map: ${buildings.length} buildings, ${edges.length} dependencies`}
          sx={(t) => ({
            display: 'block', width: '100%', minWidth: narrow ? width + 16 : 640, height: 'auto', maxHeight: narrow ? 'none' : 380,
            '& .node rect': { fill: t.vars.palette.aurora.surfaceRaised, stroke: t.vars.palette.divider, strokeWidth: 1 },
            '& .node:hover rect, & .node:focus-visible rect': { stroke: t.vars.palette.primary.main, strokeWidth: 2 },
            '& .node': { cursor: 'pointer', outline: 'none' },
            '& .node .name': { fill: t.vars.palette.text.primary, fontSize: 13, fontWeight: 600, fontFamily: 'inherit' },
            '& .node .sub': { fill: t.vars.palette.text.secondary, fontSize: 12, fontFamily: 'inherit' },
          })}
        >
          <defs>
            {['normal', 'warning', 'critical'].map((k) => (
              <marker key={k} id={`dep-arrow-${k}`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
                <path d="M0 0L8 4L0 8Z" fill={k === 'normal' ? chart.labelFill : chart.status[k]} />
              </marker>
            ))}
          </defs>
          {edges.map((e) => {
            const a = pos[e.source];
            const b = pos[e.target];
            if (!a || !b) return null;
            const sev = cascade.get(`${e.source}>${e.target}`);
            const dim = (focus && focus !== e.source && focus !== e.target) || (lit.size > 0 && !litEdge(e) && !sev);
            const on = litEdge(e);
            return (
              <path key={`${e.source}-${e.target}`} d={edgePath(a, b)} fill="none"
                stroke={sev ? chart.status[sev] : on ? chart.accent : chart.labelFill} strokeWidth={sev || on ? 2.25 : 1.5}
                strokeOpacity={dim ? 0.15 : sev || on ? 1 : 0.7} strokeDasharray={RELATION_DASH[e.relation] ?? undefined}
                markerEnd={`url(#dep-arrow-${sev || 'normal'})`} data-cascade={sev || undefined} data-highlighted={on || undefined} />
            );
          })}
          {buildings.map((b) => {
            const p = pos[b.id];
            const lvl = levelOf(b.id);
            return (
              <g key={b.id} className="node" role="button" tabIndex={0} transform={`translate(${p.x} ${p.y})`}
                aria-label={`${b.name}: ${STATUS_LABEL[lvl]}. Open details`}
                data-testid={`dep-node-${b.id}`} data-status={lvl} data-highlighted={lit.has(b.id) || undefined}
                onMouseEnter={() => setFocus(b.id)} onMouseLeave={() => setFocus(null)}
                onFocus={() => setFocus(b.id)} onBlur={() => setFocus(null)}
                onClick={() => onOpenBuilding?.(b.id)}
                onKeyDown={(ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); onOpenBuilding?.(b.id); } }}>
                {lit.has(b.id) && <rect x={-5} y={-5} width={NODE_W + 10} height={NODE_H + 10} rx={14} fill="none"
                  stroke={chart.accent} strokeWidth={2} strokeDasharray="5 3" />}
                <rect width={NODE_W} height={NODE_H} rx={10}
                  style={lvl !== 'normal' ? { stroke: chart.status[lvl], strokeWidth: 2 } : undefined} />
                <circle cx={16} cy={NODE_H / 2} r={5} fill={chart.status[lvl]} />
                <text className="name" x={30} y={22}>{b.name.length > 17 ? `${b.name.slice(0, 16)}…` : b.name}</text>
                <text className="sub" x={30} y={39}>{STATUS_LABEL[lvl]}</text>
              </g>
            );
          })}
        </Box>
      </Box>

      {dependencyAlerts.length > 0 && (
        <Box sx={{ mt: 4 }} data-testid="cascade-list">
          <Typography variant="h3" component="h3" sx={{ mb: 2 }}>Cascade risks</Typography>
          <Stack component="ul" sx={{ m: 0, pl: 0, listStyle: 'none', gap: 1.5 }}>
            {dependencyAlerts.map((d) => {
              const chain = d.chain?.length ? d.chain : [d.sourceBuilding, d.affectedBuilding];
              return (
                <Stack key={chain.join('>')} component="li" direction="row" sx={{ gap: 2, alignItems: 'center', fontSize: 14 }}>
                  <Box component="span" sx={(t) => ({ width: 8, height: 8, borderRadius: '50%', flex: 'none', backgroundColor: t.vars.palette.status[d.severity === 'critical' ? 'critical' : 'warning'] })} />
                  <span>{chain.map((id) => names[id] || id).join(' → ')}</span>
                  <Typography variant="caption" sx={{ color: 'text.secondary' }}>{d.severity === 'critical' ? 'Critical' : 'Warning'}</Typography>
                </Stack>
              );
            })}
          </Stack>
        </Box>
      )}

      <Button size="small" sx={{ mt: 3 }} onClick={() => setShowList((v) => !v)} aria-expanded={showList} data-testid="dep-list-toggle">
        {showList ? 'Hide' : 'Show'} dependencies as a list
      </Button>
      <Collapse in={showList} unmountOnExit>
        <Table size="small" aria-label="Dependencies" sx={{ mt: 2 }}>
          <TableHead>
            <TableRow><TableCell sx={{ pl: 0 }}>From</TableCell><TableCell>Relation</TableCell><TableCell>To</TableCell><TableCell sx={{ pr: 0 }}>Cascade</TableCell></TableRow>
          </TableHead>
          <TableBody>
            {edges.map((e) => {
              const sev = cascade.get(`${e.source}>${e.target}`);
              return (
                <TableRow key={`${e.source}-${e.target}`}>
                  <TableCell sx={{ pl: 0 }}>{names[e.source]}</TableCell>
                  <TableCell>{e.relation}</TableCell>
                  <TableCell>{names[e.target]}</TableCell>
                  <TableCell sx={{ pr: 0, color: 'text.secondary' }}>{sev ? STATUS_LABEL[sev] : '—'}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </Collapse>
    </Box>
  );
}
