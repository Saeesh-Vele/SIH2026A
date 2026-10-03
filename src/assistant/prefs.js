/* Aurora assistant — per-viewer settings (a browser convenience only: storage can be
   unavailable or cleared, and then the defaults apply for this page load). */
const KEY = 'aurora-assistant-v1';

export const DEFAULT_PREFS = { voice: true, autoNavigate: true, rate: 1, conversation: false, lang: 'en', announceAll: false };

export function loadPrefs() {
  try {
    const raw = window.localStorage.getItem(KEY);
    const p = raw ? JSON.parse(raw) : {};
    return {
      voice: typeof p.voice === 'boolean' ? p.voice : DEFAULT_PREFS.voice,
      autoNavigate: typeof p.autoNavigate === 'boolean' ? p.autoNavigate : DEFAULT_PREFS.autoNavigate,
      rate: Number.isFinite(p.rate) ? Math.min(1.5, Math.max(0.7, p.rate)) : DEFAULT_PREFS.rate,
      conversation: typeof p.conversation === 'boolean' ? p.conversation : DEFAULT_PREFS.conversation,
      lang: p.lang === 'hi' ? 'hi' : 'en',
      announceAll: typeof p.announceAll === 'boolean' ? p.announceAll : DEFAULT_PREFS.announceAll,
    };
  } catch (err) {
    console.warn('[Aurora] settings unavailable; using defaults', err);
    return { ...DEFAULT_PREFS };
  }
}

export function savePrefs(p) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(p));
  } catch (err) {
    console.warn('[Aurora] could not save settings', err);
  }
}
