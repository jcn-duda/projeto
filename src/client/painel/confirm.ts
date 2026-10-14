import { html, useState, useEffect, useRef } from './vendor/preact.js';

/** Texto e rótulos do modal de confirmação. `danger` pinta o botão de confirmar
 * como destrutivo; o foco inicial fica SEMPRE no cancelar. */
export interface ConfirmOptions {
  message: string;
  title?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  detail?: string;
  danger?: boolean;
}

interface PendingConfirm {
  id: number;
  options: ConfirmOptions;
  resolve: (approved: boolean) => void;
}

type ConfirmListener = (request: PendingConfirm | null) => void;

// Fila módulo-level: UM host (ConfirmHost, montado uma vez no app) mostra a
// cabeça e resolve a promise. Cada view pede sem montar o próprio modal.
let queue: PendingConfirm[] = [];
let seq = 0;
const listeners = new Set<ConfirmListener>();

function head(): PendingConfirm | null {
  return queue.length > 0 ? queue[0] : null;
}

function notify(): void {
  const current = head();
  for (const listener of listeners) listener(current);
}

export function subscribeConfirm(listener: ConfirmListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Pede confirmação e devolve `true` só quando o operador confirma. */
export function requestConfirm(message: string, options: Partial<ConfirmOptions> = {}): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    queue = [...queue, { id: ++seq, options: { message, ...options }, resolve }];
    notify();
  });
}

/**
 * Resolve a requisição pelo ID RENDERIZADO, não pela cabeça da fila. A
 * diferença fecha o duplo-settle teórico: com a cabeça, um segundo `onResolve`
 * do mesmo modal (clique repetido/Esc + clique) resolvia a requisição SEGUINTE.
 * Id já resolvido não existe mais na fila e vira no-op.
 */
function settle(id: number, approved: boolean): void {
  const current = queue.find((item) => item.id === id);
  if (!current) return;
  queue = queue.filter((item) => item.id !== id);
  current.resolve(approved);
  notify();
}

export type ConfirmRequestFn = (message: string, options?: Partial<ConfirmOptions>) => Promise<boolean>;

/** Hook de conveniência: devolve a função de confirmação (estável, do módulo). */
export function useConfirm(): ConfirmRequestFn {
  return requestConfirm;
}

export interface ConfirmModalProps {
  options: ConfirmOptions;
  onResolve: (approved: boolean) => void;
}

/** Modal de confirmação: fecha no Esc e no clique FORA do cartão, prende o foco
 * (Tab/Shift+Tab) e devolve o foco ao elemento anterior ao fechar. */
export function ConfirmModal({ options, onResolve }: ConfirmModalProps) {
  const cancelRef = useRef<HTMLButtonElement>();
  const cardRef = useRef<HTMLDivElement>();
  const previousFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    previousFocus.current =
      typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null;
    // O foco inicial NUNCA vai para o confirmar: um Enter repetido não pode
    // disparar a ação destrutiva que o modal existe para segurar.
    const cancel = cancelRef.current;
    if (cancel && typeof cancel.focus === 'function') cancel.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onResolve(false);
        return;
      }
      if (event.key !== 'Tab') return;
      const card = cardRef.current;
      if (!card) return;
      const focusables = card.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !card.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !card.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      const previous = previousFocus.current;
      if (previous && typeof previous.focus === 'function') previous.focus();
    };
  }, []);

  const onBackdrop = (event: any) => {
    // Só o clique no PRÓPRIO backdrop cancela; clique dentro do cartão tem
    // target diferente e não fecha.
    if (event.target === event.currentTarget) onResolve(false);
  };

  return html`
    <div class="painel-modal" role="presentation" onClick=${onBackdrop}>
      <div
        class="painel-modal-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="painel-confirm-title"
        ref=${cardRef}
      >
        <h2 class="painel-modal-title" id="painel-confirm-title">${options.title || 'Confirmar ação'}</h2>
        <p class="painel-modal-text">${options.message}</p>
        ${options.detail ? html`<p class="painel-modal-detail">${options.detail}</p>` : null}
        <div class="painel-modal-actions">
          <button type="button" class="painel-btn" ref=${cancelRef} onClick=${() => onResolve(false)}>
            ${options.cancelLabel || 'Cancelar'}
          </button>
          <button
            type="button"
            class=${'painel-btn ' + (options.danger ? 'painel-btn-danger' : 'painel-btn-accent')}
            onClick=${() => onResolve(true)}
          >
            ${options.confirmLabel || 'Confirmar'}
          </button>
        </div>
      </div>
    </div>
  `;
}

/** Host do modal: montado UMA vez no app (fora das abas e dos estados de
 * loading). Sem host, toda confirmação fica pendente para sempre. */
export function ConfirmHost() {
  const [request, setRequest] = useState<PendingConfirm | null>(head());
  useEffect(() => subscribeConfirm(setRequest), []);
  if (!request) return null;
  // O handler carrega o id DESTE request: o modal resolve o que renderizou,
  // não o que estiver na cabeça quando o clique chegar.
  return html`<${ConfirmModal} key=${request.id} options=${request.options}
    onResolve=${(approved: boolean) => settle(request.id, approved)} />`;
}
