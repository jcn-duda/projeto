import { useState, useEffect, useRef, useCallback } from './vendor/preact.js';
import { postAction } from './api.js';
import { getPainelState, pushPainelToast } from './store.js';
import { pollOnce } from './poll.js';
import { useConfirm, type ConfirmOptions } from './confirm.js';

/** Pedido de ação: `confirm` abre o modal e, aprovado, injeta `confirm: true`
 * no corpo (o backend exige isso nas DESTRUCTIVE_ACTIONS). */
export interface ActionRequest {
  action: string;
  body?: Record<string, any>;
  confirm?: string | ConfirmOptions;
  /** Blocos recarregados por `pollOnce` DEPOIS do sucesso. */
  poll?: string[];
  successToast?: string | ((data: Record<string, any>) => string);
  /** Mensagem quando o corpo responde `ok:false` sem `error`/`reason`. */
  failureFallback?: string;
}

export type ActionOutcome =
  | { ok: true; data: Record<string, any> }
  | { ok: false; aborted: true; data?: Record<string, any> }
  | { ok: false; aborted?: false; status: number; error: string; data?: Record<string, any> };

export interface UseAction {
  pending: boolean;
  run: (request: ActionRequest) => Promise<ActionOutcome>;
}

const BUSY_GATE_ERROR = 'já existe um teste em andamento';
const BUSY_GATE_MESSAGE = 'Outra operação de diagnóstico está em andamento. Aguarde e tente novamente.';

/** Texto de erro para o feedback inline do card; `null` quando cancelado/ok. */
export function actionError(outcome: ActionOutcome): string | null {
  if (outcome.ok) return null;
  if (outcome.aborted) return null;
  if (outcome.error.trim().toLocaleLowerCase('pt-BR') === BUSY_GATE_ERROR) {
    return BUSY_GATE_MESSAGE;
  }
  return outcome.error;
}

/** Detalhe estruturado da recusa: `reason`/`fix`/`errors[]` do corpo — vale
 * tanto para 400 quanto para HTTP 200 com `ok:false` (o `run` preserva o corpo
 * nos dois). Só lê campos de diagnóstico; nunca a chave/credencial. */
export interface ActionFailure { reason: string; fix: string; errors: string[]; }

export function actionFailure(outcome: ActionOutcome): ActionFailure | null {
  if (outcome.ok || outcome.aborted) return null;
  const data = outcome.data && typeof outcome.data === 'object' ? outcome.data : {};
  const str = (value: unknown) => (typeof value === 'string' ? value : '');
  return {
    reason: str(data.reason),
    fix: str(data.fix),
    errors: Array.isArray(data.errors) ? data.errors.map((e) => String(e)).filter(Boolean) : [],
  };
}

function successText(spec: ActionRequest['successToast'], data: Record<string, any>): string | null {
  if (typeof spec === 'function') return spec(data);
  return spec || null;
}

/** Centraliza o fluxo pending → postAction → toast + pollOnce das views, com
 * trava de reentrada (ref, não estado: dois cliques no mesmo frame não passam).
 * O erro NÃO vira toast — a view mantém o feedback inline do card. */
export function useAction(): UseAction {
  const [pending, setPending] = useState(false);
  // `useConfirm` devolve a função estável do módulo: a identidade não muda
  // entre renders, então o useCallback abaixo pode fechar sobre ela.
  const confirm = useConfirm();
  const busy = useRef(false);
  const mounted = useRef(true);
  useEffect(() => () => {
    mounted.current = false;
  }, []);

  const run = useCallback(async (request: ActionRequest): Promise<ActionOutcome> => {
    if (busy.current) return { ok: false, aborted: true };
    // A trava cobre também a espera do modal: sem ela, dois cliques abririam
    // duas confirmações para a mesma ação destrutiva.
    busy.current = true;
    if (mounted.current) setPending(true);
    try {
      if (request.confirm) {
        const spec = request.confirm;
        const approved = await confirm(
          typeof spec === 'string' ? spec : spec.message,
          typeof spec === 'string' ? undefined : spec,
        );
        if (!approved) return { ok: false, aborted: true };
      }

      const token = getPainelState().token;
      if (!token) return { ok: false, aborted: true };

      const body = request.confirm ? { ...(request.body || {}), confirm: true } : request.body || {};
      const res = await postAction(token, request.action, body);

      if (res.ok && res.data.ok !== false) {
        const text = successText(request.successToast, res.data);
        if (text) pushPainelToast(text, 'ok');
        if (request.poll && request.poll.length > 0) await pollOnce(request.poll);
        return { ok: true, data: res.data };
      }

      const error = res.ok
        ? String(res.data.error || res.data.reason || request.failureFallback || 'ação indisponível')
        : res.error;
      // O corpo do erro viaja junto quando o servidor manda `reason`/`fix`
      // (400 de validação): a view decide se mostra o motivo específico.
      return { ok: false, status: res.ok ? 0 : res.status, error, data: res.data };
    } finally {
      busy.current = false;
      if (mounted.current) setPending(false);
    }
  }, []);

  return { pending, run };
}
