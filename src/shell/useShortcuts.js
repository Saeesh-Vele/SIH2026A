/* ═══════════════════════════════════════════════════════════════
   Aurora — global keyboard shortcuts.
     ⌘K / Ctrl+K   command palette
     ?             keyboard shortcuts help
     g then a key  go to a page (keys in navigation.js), within 1.5 s
     hold V        push-to-talk to Aurora (released: Aurora hears what was said)
     Esc           closes the open dialog or drawer (handled by MUI)
   Ignored while the product tour runs (it uses ← → Esc itself).
   Ignored while typing in a field, so they never steal keystrokes.
   ═══════════════════════════════════════════════════════════════ */
import { useEffect, useRef } from 'react';

export function isTypingTarget(el) {
  if (!el) return false;
  const tag = el.tagName;
  return el.isContentEditable || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

export function useShortcuts({ onPalette, onHelp, onGo, onTalk }) {
  const pendingG = useRef(0);
  const talking = useRef(false);
  const handlers = useRef({ onPalette, onHelp, onGo, onTalk });
  useEffect(() => { handlers.current = { onPalette, onHelp, onGo, onTalk }; });

  useEffect(() => {
    const onKey = (e) => {
      const h = handlers.current;
      // The product tour owns the keyboard (← → Esc) while it runs.
      if (document.body.classList.contains('driver-active')) return;
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        h.onPalette();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target)) return;
      if (e.key === '?') { e.preventDefault(); h.onHelp(); return; }
      const now = Date.now();
      if (pendingG.current && now - pendingG.current < 1500 && /^[a-z]$/.test(e.key)) {
        pendingG.current = 0;
        if (h.onGo(e.key)) e.preventDefault();
        return;
      }
      if ((e.key === 'v' || e.key === 'V') && h.onTalk) {
        e.preventDefault();
        if (!e.repeat && !talking.current) { talking.current = true; h.onTalk(true); }
        return;
      }
      pendingG.current = e.key === 'g' ? now : 0;
    };
    const onKeyUp = (e) => {
      if ((e.key === 'v' || e.key === 'V') && talking.current) { talking.current = false; handlers.current.onTalk?.(false); }
    };
    const onBlur = () => { if (talking.current) { talking.current = false; handlers.current.onTalk?.(false); } };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, []);
}
