/* ═══════════════════════════════════════════════════════════════
   Aurora — welcome card and story picker (judge mode). Loaded on demand.

   Welcome: what the problem is, what Aurora does, what is real and what is
   simulated, then three choices: Play a scenario (the story list), Take the
   tour, Ask Aurora, Explore on my own. Shown once on a first visit; reopened from Help.

   Stories: the guided stories with their availability. Scenario stories share
   the station's public demo slot; when another scenario is running there the
   card says so ("try again in 1:20") and the other stories stay available.
   ═══════════════════════════════════════════════════════════════ */
import { Box, Button, ButtonBase, Dialog, DialogContent, DialogTitle, IconButton, Link, Stack, Typography } from '@mui/material';
import ArrowBackOutlined from '@mui/icons-material/ArrowBackOutlined';
import CloseOutlined from '@mui/icons-material/CloseOutlined';
import ExploreOutlined from '@mui/icons-material/ExploreOutlined';
import PlayCircleOutlineOutlined from '@mui/icons-material/PlayCircleOutlineOutlined';
import TourOutlined from '@mui/icons-material/TourOutlined';
import MicNoneOutlined from '@mui/icons-material/MicNoneOutlined';
import { STORIES, STORY_IDS } from '../tour/stories';
import { storyAvailability } from '../tour/storyRuntime';
import { stationMeta } from '../data/stationConfig';

function Choice({ icon, title, text, onClick, testId, primary }) {
  return (
    <ButtonBase onClick={onClick} data-testid={testId}
      sx={(t) => ({
        display: 'flex', alignItems: 'flex-start', justifyContent: 'flex-start', gap: 3, width: '100%', textAlign: 'left', p: 4, borderRadius: '10px',
        border: `1px solid ${primary ? t.vars.palette.primary.main : t.vars.palette.divider}`,
        bgcolor: primary ? t.vars.palette.aurora.accentTint : 'transparent',
        '&:hover, &.Mui-focusVisible': { bgcolor: t.vars.palette.aurora.surfaceRaised },
      })}>
      <Box sx={{ color: 'primary.main', pt: 0.25 }}>{icon}</Box>
      <Box>
        <Typography sx={{ fontWeight: 600, fontSize: 15 }}>{title}</Typography>
        <Typography variant="body2" sx={{ color: 'text.secondary', mt: 0.5 }}>{text}</Typography>
      </Box>
    </ButtonBase>
  );
}

export default function WelcomeDialog({ open, view = 'welcome', onView, onClose, onChoose, onPlayStory, onAbout, stationData, canRunScenarios }) {
  const stories = view === 'stories';
  const availability = storyAvailability(stationData, canRunScenarios);
  return (
    <Dialog open={open} onClose={() => onClose('closed')} maxWidth="sm" fullWidth aria-labelledby="welcome-title"
      slotProps={{ paper: { 'data-testid': stories ? 'story-picker' : 'welcome-card' } }}>
      <DialogTitle id="welcome-title" sx={{ display: 'flex', alignItems: 'center', gap: 2, pr: 2 }}>
        {stories && (
          <IconButton onClick={() => onView('welcome')} aria-label="Back to the welcome card" size="small"><ArrowBackOutlined fontSize="small" /></IconButton>
        )}
        <Box component="span" sx={{ flex: 1 }}>{stories ? 'Play a scenario' : 'Welcome to Aurora'}</Box>
        <IconButton onClick={() => onClose('closed')} aria-label="Close"><CloseOutlined /></IconButton>
      </DialogTitle>
      <DialogContent>
        {!stories ? (
          <>
            <Typography variant="body2" sx={{ color: 'text.secondary', mb: 1 }}>
              Smart India Hackathon · Problem statement 26060 · Ministry of Earth Sciences / NCPOR
            </Typography>
            <Typography sx={{ fontSize: 16, fontWeight: 600, mb: 2 }}>
              Keeping watch over India&apos;s Antarctic research stations, Maitri and Bharati, from thousands of kilometres away.
            </Typography>
            <Typography variant="body2" sx={{ mb: 2 }}>
              Aurora is a digital twin: a live computer model of both stations. It simulates their power, heating, water and communications
              under each station&apos;s real weather, raises an alert when something goes out of range, and explains in plain words what to do.
            </Typography>
            <Typography variant="body2" sx={{ color: 'text.secondary', mb: 4 }}>
              <strong>Real vs simulated:</strong> the weather is real past weather for each station (ERA5 records), replayed hour by hour.
              The equipment readings come from our model, and the faults you can trigger are simulated. Every value is labelled with its source.{' '}
              <Link component="button" type="button" onClick={onAbout} data-testid="welcome-provenance-link" sx={{ verticalAlign: 'baseline' }}>How we label data</Link>
            </Typography>
            <Stack sx={{ gap: 2 }}>
              <Choice primary icon={<PlayCircleOutlineOutlined />} title="Play a scenario" testId="welcome-play"
                text="A guided two-minute story: a blizzard at Maitri, a generator failure or a satellite link drop at Bharati, or running low on fuel."
                onClick={() => onView('stories')} />
              <Choice icon={<MicNoneOutlined />} title="Ask Aurora" testId="welcome-aurora"
                text="Talk or type to the station assistant: “What happens if there's a blizzard at Maitri?” It answers from the station's data and can open pages for you."
                onClick={() => onChoose('aurora')} />
              <Choice icon={<TourOutlined />} title="Take the tour" testId="welcome-tour"
                text="A quick walk through each part of the screen, in 13 short steps." onClick={() => onChoose('tour')} />
              <Choice icon={<ExploreOutlined />} title="Explore on my own" testId="welcome-explore"
                text="Everything is open to try. Your changes are private to you and reset after an hour." onClick={() => onChoose('explore')} />
            </Stack>
            <Typography variant="caption" component="p" sx={{ color: 'text.secondary', mt: 3, mb: 0 }}>
              You can reopen this card, the stories and the tour from Help (?) at any time.
            </Typography>
          </>
        ) : (
          <Stack sx={{ gap: 2 }}>
            {STORY_IDS.map((id) => {
              const s = STORIES[id];
              const a = availability[id] || { ok: true };
              return (
                <Box key={id} sx={(t) => ({ p: 4, borderRadius: '10px', border: `1px solid ${t.vars.palette.divider}` })} data-testid={`story-card-${id}`}>
                  <Stack direction="row" sx={{ gap: 2, alignItems: 'baseline' }}>
                    <Typography sx={{ fontWeight: 600, fontSize: 15, flex: 1 }}>{s.title}</Typography>
                    <Typography variant="caption" sx={{ color: 'text.secondary' }}>{stationMeta(s.station).name} · about {s.minutes} min</Typography>
                  </Stack>
                  <Typography variant="body2" sx={{ color: 'text.secondary', mt: 1 }}>{s.summary}</Typography>
                  {a.note && <Typography variant="body2" sx={{ mt: 1.5 }} data-testid={`story-note-${id}`}>{a.note}</Typography>}
                  <Box sx={{ mt: 2 }}>
                    <Button variant={a.ok ? 'contained' : 'outlined'} disabled={!a.ok} onClick={() => onPlayStory(id)} data-testid={`story-play-${id}`}>
                      {a.ok ? (a.joins ? 'Join and play' : 'Play') : 'Not available right now'}
                    </Button>
                  </Box>
                </Box>
              );
            })}
          </Stack>
        )}
      </DialogContent>
    </Dialog>
  );
}
