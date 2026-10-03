/* ═══════════════════════════════════════════════════════════════
   Aurora — toasts and confirmation dialogs, one provider for the app.

   Toasts: one at a time, queued; success/info close after 5 s, warnings and
   errors stay until dismissed (an error should not vanish unread), announced
   to screen readers (role status / alert). Confirm: a modal resolving a
   promise; Esc / backdrop = cancel; for destructive actions Cancel has focus.
   The UI half (FeedbackUI) loads on first use to keep startup JS small.
   ═══════════════════════════════════════════════════════════════ */
import { lazy, Suspense, useCallback, useRef, useState } from 'react';
import { ConfirmContext, ToastContext } from './feedbackContext';

const FeedbackUI = lazy(() => import('./FeedbackUI'));

export default function FeedbackProvider({ children }) {
  const [queue, setQueue] = useState([]);
  const [toastOpen, setToastOpen] = useState(true);
  const [ask, setAsk] = useState(null);
  const [used, setUsed] = useState(false);
  const idRef = useRef(0);

  const toast = useCallback((t) => {
    idRef.current += 1;
    setUsed(true);
    setQueue((q) => [...q, { severity: 'success', ...t, id: idRef.current }]);
    setToastOpen(true);
  }, []);
  // `bind(settle)` hands the caller a way to answer too (Aurora: "yes" / "no" by voice).
  const confirm = useCallback((opts) => new Promise((resolve) => {
    setUsed(true);
    const settle = (v) => { resolve(v); setAsk((cur) => (cur?.resolve === settle ? null : cur)); };
    setAsk({ ...opts, resolve: settle });
    opts?.bind?.(settle);
  }), []);
  const answer = (v) => { ask?.resolve(v); };

  return (
    <ToastContext.Provider value={toast}>
      <ConfirmContext.Provider value={confirm}>
        {children}
        {used && (
          <Suspense fallback={null}>
            <FeedbackUI toast={queue[0]} toastOpen={toastOpen} onToastClose={() => setToastOpen(false)}
              onToastExited={() => { setQueue((q) => q.slice(1)); setToastOpen(true); }}
              ask={ask} onAnswer={answer} />
          </Suspense>
        )}
      </ConfirmContext.Provider>
    </ToastContext.Provider>
  );
}
