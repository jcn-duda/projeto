import { html, useState, useEffect } from './vendor/preact.js';
import { getPainelToasts, subscribePainelToasts, dismissPainelToast, type PainelToast } from './store.js';

/** Auto-dismiss: o toast sai sozinho; o × permite fechar antes do prazo. */
export const TOAST_TTL_MS = 4000;

export interface ToastItemProps {
  toast: PainelToast;
  ttlMs?: number;
}

export function ToastItem({ toast, ttlMs = TOAST_TTL_MS }: ToastItemProps) {
  useEffect(() => {
    const timer = setTimeout(() => dismissPainelToast(toast.id), ttlMs);
    return () => clearTimeout(timer);
  }, [toast.id, ttlMs]);

  return html`
    <div class=${'painel-toast painel-toast-' + toast.variant}>
      <span class="painel-toast-text">${toast.text}</span>
      <button
        type="button"
        class="painel-toast-close"
        aria-label="Fechar aviso"
        onClick=${() => dismissPainelToast(toast.id)}
      >
        ×
      </button>
    </div>
  `;
}

export interface ToastStackProps {
  ttlMs?: number;
}

/** Fila global de toasts: montada UMA vez no app; a lista vive no store e o
 * stack só assina o canal próprio (não re-renderiza o painel inteiro). */
export function ToastStack({ ttlMs }: ToastStackProps = {}) {
  const [toasts, setToasts] = useState<PainelToast[]>(getPainelToasts());
  useEffect(() => subscribePainelToasts(setToasts), []);
  return html`
    <div class="painel-toasts" role="status" aria-live="polite">
      ${toasts.map((toast) => html`<${ToastItem} key=${toast.id} toast=${toast} ttlMs=${ttlMs} />`)}
    </div>
  `;
}
