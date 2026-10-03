/* Aurora — contexts for toasts and confirmations (see FeedbackProvider). */
import { createContext, useContext } from 'react';

export const ToastContext = createContext(() => {});
export const ConfirmContext = createContext(() => Promise.resolve(true));

/** toast({ text, severity: 'success' | 'info' | 'warning' | 'error' }) */
export const useToast = () => useContext(ToastContext);

/**
 * await confirm({ title, body, confirmLabel, danger, bind }) → true / false.
 * `bind(settle)` receives a function that answers the dialog (voice confirmation).
 * Every state-changing action asks first (rollout 1B rule).
 */
export const useConfirm = () => useContext(ConfirmContext);
