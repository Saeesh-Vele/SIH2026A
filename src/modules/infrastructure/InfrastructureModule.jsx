/* ═══════════════════════════════════════════════════════════════
   Aurora — Infrastructure module (rollout 1B, checkpoint 1).

   Same data as the legacy InfrastructurePanel: per-building alert levels,
   live telemetry, the backend's cascade analysis and station health, all from
   the telemetry snapshot; buildings, sensors and the dependency graph from
   station_config.json. "Station health" is the snapshot's rule-based roll-up
   (threshold alerts + cascade rules), not an AI judgement, and says so.
   ═══════════════════════════════════════════════════════════════ */
import { Box, ButtonBase, Card, Stack, Typography } from '@mui/material';
import ChevronRightOutlined from '@mui/icons-material/ChevronRightOutlined';
import { buildingList, sensorCatalog, stationMeta } from '../../data/stationConfig';
import { formatNumber, isNum } from '../../lib/format';
import KpiCard from '../../ui/KpiCard';
import PageHeader from '../../ui/PageHeader';
import ProvenanceChip from '../../ui/Provenance';
import SectionCard from '../../ui/SectionCard';
import StatusDot from '../../ui/StatusDot';
import { StatusChip } from '../../ui/Status';
import { STATUS_LABEL } from '../../ui/statusLabels';
import { MODULES, sectionLabel } from '../../shell/navigation';
import DependencyMap from './DependencyMap';
import { useAssistant } from '../../assistant/bus';

const HEALTH = { healthy: 'normal', warning: 'warning', critical: 'critical' };
const DECIMALS = { rpm: 0, ppm: 0, items: 0, pH: 2, '%': 0, days: 0 };

function BuildingTile({ building, sensors, level, catalog, onOpen, highlighted }) {
  const readings = Object.entries(catalog).filter(([, c]) => c.building === building.id).slice(0, 3);
  return (
    <Card sx={(t) => ({ height: '100%', ...(highlighted ? { outline: `2px solid ${t.vars.palette.primary.main}`, outlineOffset: 2 } : {}) })}>
      <ButtonBase
        onClick={() => onOpen(building.id)}
        data-testid={`building-tile-${building.id}`}
        data-highlighted={highlighted || undefined}
        aria-label={`${building.name}: ${STATUS_LABEL[level]}. Open details`}
        sx={(t) => ({
          display: 'flex', flexDirection: 'column', alignItems: 'stretch', textAlign: 'left', width: '100%', height: '100%', p: 5, gap: 3,
          borderRadius: 'inherit',
          transition: t.transitions.create('background-color', { duration: t.transitions.duration.shortest }),
          '&:hover': { backgroundColor: t.vars.palette.action.hover },
          '&:hover .chev': { color: t.vars.palette.text.primary },
        })}
      >
        <Stack direction="row" sx={{ alignItems: 'flex-start', gap: 2 }}>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography sx={{ fontWeight: 600, fontSize: 15 }}>{building.name}</Typography>
            {highlighted && <Typography variant="caption" sx={{ color: 'primary.main', fontWeight: 600, display: 'block' }}>Highlighted by Aurora</Typography>}
            <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'capitalize' }}>{building.module}</Typography>
          </Box>
          {level !== 'normal' ? <StatusChip status={level} /> : (
            <Stack direction="row" sx={{ alignItems: 'center', gap: 1, color: 'text.secondary', fontSize: 12 }}>
              <StatusDot status="normal" size={7} />Normal
            </Stack>
          )}
        </Stack>
        <Box component="dl" sx={{ m: 0, display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', rowGap: 1.5, columnGap: 3 }}>
          {readings.length ? readings.map(([id, c]) => {
            const v = sensors?.[id];
            return (
              <Box key={id} sx={{ display: 'contents' }}>
                <Typography component="dt" variant="body2" sx={{ color: 'text.secondary', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</Typography>
                <Typography component="dd" variant="body2" sx={{ m: 0, textAlign: 'right', fontFeatureSettings: '"tnum" 1', fontWeight: 500 }}>
                  {isNum(v) ? `${formatNumber(v, DECIMALS[c.unit] ?? 1)} ${c.unit}` : '—'}
                </Typography>
              </Box>
            );
          }) : <Typography variant="body2" sx={{ color: 'text.secondary' }}>No sensors configured</Typography>}
        </Box>
        <Stack direction="row" className="chev" sx={{ mt: 'auto', alignItems: 'center', gap: 0.5, color: 'text.secondary', fontSize: 13, fontWeight: 500 }}>
          Details <ChevronRightOutlined sx={{ fontSize: 18 }} />
        </Stack>
      </ButtonBase>
    </Card>
  );
}

export default function InfrastructureModule({
  sensorData = {}, alerts = {}, activeAlerts = [], dependencyAlerts = [], aiHealth = 'healthy', provenance,
  activeStation = 'maitri', updatedAt, onOpenBuilding, telemetrySource,
}) {
  const meta = MODULES.infrastructure;
  const buildings = buildingList(activeStation);
  const catalog = sensorCatalog(activeStation);
  const levelOf = (id) => (alerts[id] === 'critical' || alerts[id] === 'warning' ? alerts[id] : 'normal');
  const levels = buildings.map((b) => levelOf(b.id));
  const normal = levels.filter((l) => l === 'normal').length;
  const crit = activeAlerts.filter((a) => a.level === 'critical').length;
  const warn = activeAlerts.length - crit;
  const health = HEALTH[aiHealth] || 'normal';
  const station = stationMeta(activeStation).name;
  const equipmentKind = telemetrySource === 'browser-demo' ? 'SIMULATED' : provenance?.equipment;
  const hl = useAssistant((s) => s.highlight);
  const highlighted = new Set(hl?.station === activeStation ? hl.ids : []);

  return (
    <Box data-testid="infrastructure-module">
      <PageHeader
        tourId="infrastructure"
        section={sectionLabel(meta.section)}
        title={meta.title}
        description={`${meta.description} ${station} station.`}
        updatedAt={updatedAt}
        updatedLabel="Snapshot"
        provenance={<>
          {equipmentKind && <ProvenanceChip kind={equipmentKind} subject="Equipment" />}
          {provenance?.environment && <ProvenanceChip kind={provenance.environment} subject="Environment" />}
          <ProvenanceChip kind="MODEL-DERIVED" subject="Cascade rules" detail="Cascade risks follow the dependency graph in station_config.json." />
        </>}
      />

      <Typography variant="h2" sx={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap' }}>Status summary</Typography>
      <Box component="section" aria-label="Status summary" data-testid="infra-kpis" sx={{
        display: 'grid', gap: 4, mb: 4,
        gridTemplateColumns: { xs: 'repeat(2, minmax(0, 1fr))', lg: 'minmax(0, 1.6fr) repeat(2, minmax(0, 1fr))' },
        gridTemplateAreas: { xs: '"hero hero" "a b" "c c"', lg: '"hero a b" "hero c c"' },
      }}>
        <Card component="section" aria-label="Subsystems normal" data-testid="kpi-subsystems" sx={{ gridArea: 'hero', p: 6, display: 'flex', flexDirection: 'column', gap: 3 }}>
          <Typography variant="label" component="h3" sx={{ color: 'text.secondary' }}>Subsystems normal</Typography>
          <Stack direction="row" sx={{ alignItems: 'baseline', gap: 1.5 }}>
            <Typography variant="kpiHero" component="p" sx={{ m: 0 }}>{normal}</Typography>
            <Typography sx={{ color: 'text.secondary', fontSize: 20, fontWeight: 500 }}>of {buildings.length}</Typography>
          </Stack>
          <Box component="ul" sx={{ m: 0, p: 0, listStyle: 'none', mt: 'auto', display: 'grid', gridTemplateColumns: { xs: 'minmax(0, 1fr)', sm: 'repeat(2, minmax(0, 1fr))' }, columnGap: 6, rowGap: 2 }}>
            {buildings.map((b) => {
              const l = levelOf(b.id);
              return (
                <Stack key={b.id} component="li" direction="row" sx={{ alignItems: 'center', gap: 2, fontSize: 14, minWidth: 0 }}>
                  <StatusDot status={l} size={8} />
                  <Box component="span" sx={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{b.name}</Box>
                  <Box component="span" sx={(t) => ({ fontSize: 12, fontWeight: l === 'normal' ? 400 : 600, color: l === 'normal' ? t.vars.palette.text.secondary : t.vars.palette.status[l] })}>{STATUS_LABEL[l]}</Box>
                </Stack>
              );
            })}
          </Box>
        </Card>
        <KpiCard label="Active alerts" value={activeAlerts.length} testId="kpi-alerts" sx={{ gridArea: 'a' }}
          status={crit ? 'critical' : warn ? 'warning' : undefined}
          context={activeAlerts.length ? `${crit} critical · ${warn} warning` : 'All sensors within thresholds'} />
        <KpiCard label="Cascade risks" value={dependencyAlerts.length} testId="kpi-cascades" sx={{ gridArea: 'b' }}
          status={dependencyAlerts.some((d) => d.severity === 'critical') ? 'critical' : dependencyAlerts.length ? 'warning' : undefined}
          context={dependencyAlerts.length ? 'Downstream buildings at risk' : 'No downstream risk'} />
        <Card component="section" aria-label="Station health" data-testid="kpi-health" sx={{ gridArea: 'c', p: 5, display: 'flex', flexDirection: 'column', gap: 2 }}>
          <Typography variant="label" component="h3" sx={{ color: 'text.secondary' }}>Station health</Typography>
          <Box><StatusChip status={health} /></Box>
          <Typography variant="body2" sx={{ color: 'text.secondary', mt: 'auto' }}>
            {telemetrySource === 'browser-demo'
              ? 'Rule-based roll-up of the browser-demo alerts. The backend alert engine is unreachable.'
              : 'Rule-based roll-up of threshold alerts and cascade risks from the backend alert engine.'}
          </Typography>
        </Card>
      </Box>

      <Box component="section" aria-labelledby="infra-buildings-heading" sx={{ mb: 4 }}>
        <Typography id="infra-buildings-heading" variant="h2" sx={{ mb: 3 }}>Buildings</Typography>
        <Box data-testid="building-grid" sx={{ display: 'grid', gap: 4, gridTemplateColumns: { xs: 'minmax(0, 1fr)', sm: 'repeat(2, minmax(0, 1fr))', lg: 'repeat(4, minmax(0, 1fr))' } }}>
          {buildings.map((b) => (
            <BuildingTile key={b.id} building={b} sensors={sensorData[b.id]} level={levelOf(b.id)} catalog={catalog} onOpen={onOpenBuilding} highlighted={highlighted.has(b.id)} />
          ))}
        </Box>
      </Box>

      <SectionCard title="Dependency map" subtitle="Which subsystem feeds which, and where a fault would cascade. Select a building for details."
        provenance={<ProvenanceChip kind="MODEL-DERIVED" subject="Cascades" />} testId="infra-dependency">
        <DependencyMap stationId={activeStation} alerts={alerts} dependencyAlerts={dependencyAlerts} onOpenBuilding={onOpenBuilding}
          highlight={hl?.station === activeStation ? hl : null} />
      </SectionCard>
    </Box>
  );
}
