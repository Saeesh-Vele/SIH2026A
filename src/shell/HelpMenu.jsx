/* Aurora — the Help menu of the top bar (loaded on first open): the welcome card,
   the guided stories, the product tour, this page's tour where there is one, the
   keyboard shortcuts and About Aurora. */
import { ListItemIcon, ListItemText, Menu, MenuItem } from '@mui/material';
import KeyboardOutlined from '@mui/icons-material/KeyboardOutlined';
import PlaceOutlined from '@mui/icons-material/PlaceOutlined';
import TourOutlined from '@mui/icons-material/TourOutlined';
import InfoOutlined from '@mui/icons-material/InfoOutlined';
import PlayCircleOutlineOutlined from '@mui/icons-material/PlayCircleOutlineOutlined';
import WavingHandOutlined from '@mui/icons-material/WavingHandOutlined';
import Keys from '../ui/Keys';

export default function HelpMenu({ anchorEl, onClose, onStartTour, pageTourLabel, onStartPageTour, onOpenShortcuts, onOpenWelcome, onOpenStories, onOpenAbout }) {
  const pick = (fn) => () => { onClose(); fn(); };
  return (
    <Menu
      anchorEl={anchorEl}
      open={Boolean(anchorEl)}
      onClose={onClose}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
      transformOrigin={{ vertical: 'top', horizontal: 'right' }}
      slotProps={{ paper: { sx: { minWidth: 264, mt: 1 }, 'data-testid': 'help-menu' } }}
    >
      {onOpenWelcome && (
        <MenuItem onClick={pick(onOpenWelcome)} data-testid="help-welcome">
          <ListItemIcon><WavingHandOutlined fontSize="small" /></ListItemIcon>
          <ListItemText primary="Welcome" secondary="What Aurora is, and where to start" />
        </MenuItem>
      )}
      {onOpenStories && (
        <MenuItem onClick={pick(onOpenStories)} data-testid="help-stories">
          <ListItemIcon><PlayCircleOutlineOutlined fontSize="small" /></ListItemIcon>
          <ListItemText primary="Play a scenario" secondary="Guided two-minute stories" />
        </MenuItem>
      )}
      <MenuItem onClick={pick(onStartTour)} data-testid="help-tour">
        <ListItemIcon><TourOutlined fontSize="small" /></ListItemIcon>
        <ListItemText primary="Take the tour" secondary="13 steps, about a minute" />
      </MenuItem>
      {pageTourLabel && (
        <MenuItem onClick={pick(onStartPageTour)} data-testid="help-page-tour">
          <ListItemIcon><PlaceOutlined fontSize="small" /></ListItemIcon>
          <ListItemText primary="Tour this page" secondary={pageTourLabel} />
        </MenuItem>
      )}
      <MenuItem onClick={pick(onOpenShortcuts)} data-testid="help-shortcuts">
        <ListItemIcon><KeyboardOutlined fontSize="small" /></ListItemIcon>
        <ListItemText primary="Keyboard shortcuts" />
        <Keys keys={['?']} />
      </MenuItem>
      {onOpenAbout && (
        <MenuItem onClick={pick(onOpenAbout)} data-testid="help-about">
          <ListItemIcon><InfoOutlined fontSize="small" /></ListItemIcon>
          <ListItemText primary="About Aurora" />
        </MenuItem>
      )}
    </Menu>
  );
}
