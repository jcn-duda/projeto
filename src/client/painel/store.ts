import { readStored, writeStored } from './storage.js';

export interface BlockMeta {
  updatedAt: number;
}

export interface PainelState {
  token: string;
  refreshRateS: number;
  payload: Record<string, any>;
  blockMeta: Record<string, BlockMeta>;
  loading: boolean;
  error: string | null;
  lastSuccessAt: number | null;
  connectionState: 'online' | 'warn' | 'error' | 'syncing';
}

type Listener = (state: PainelState) => void;
type TokenListener = (token: string) => void;

const TOKEN_KEY = 'adom.dashboard.test-token';
const REFRESH_KEY = 'adom.dashboard.refresh-rate';

function initialRefreshRate(): number {
  const value = Number(readStored(REFRESH_KEY, '10'));
  return Number.isFinite(value) && value > 0 ? value : 10;
}

let state: PainelState = {
  token: readStored(TOKEN_KEY, ''),
  refreshRateS: initialRefreshRate(),
  payload: {},
  blockMeta: {},
  loading: false,
  error: null,
  lastSuccessAt: null,
  connectionState: 'syncing',
};

const listeners = new Set<Listener>();
// Canal separado para o token: notificação de loading/erro/merge carrega o
// MESMO token e não pode sobrescrever o que o operador está digitando. Só o
// `setPainelToken` (mudança real) alimenta este canal.
const tokenListeners = new Set<TokenListener>();

export function getPainelState(): PainelState {
  return state;
}

export function subscribePainelState(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Só dispara quando o token PERSISTIDO muda — é o input do operador que
 * acompanha, sem ser reescrito por cada poll. */
export function subscribePainelToken(listener: TokenListener): () => void {
  tokenListeners.add(listener);
  return () => {
    tokenListeners.delete(listener);
  };
}

function notify(): void {
  for (const listener of listeners) {
    listener(state);
  }
}

export function setPainelToken(token: string): void {
  const changed = token !== state.token;
  state = { ...state, token };
  writeStored(TOKEN_KEY, token);
  notify();
  if (changed) {
    for (const listener of tokenListeners) listener(token);
  }
}

export function setPainelRefreshRate(refreshRateS: number): void {
  state = { ...state, refreshRateS };
  writeStored(REFRESH_KEY, String(refreshRateS));
  notify();
}

export function setPainelLoading(loading: boolean): void {
  state = { ...state, loading };
  notify();
}

export function setPainelError(error: string | null): void {
  state = {
    ...state,
    error,
    loading: false,
    connectionState: error ? 'error' : 'online',
  };
  notify();
}

/** Falha TRANSITÓRIA (429 do gate): preserva os dados já carregados e sai de
 * `syncing` — sem isto, um 429 na primeira rodada deixava o badge preso em
 * SINCRONIZANDO para sempre, sem indicar que a leitura não completou. */
export function setPainelWarning(): void {
  state = { ...state, error: null, loading: false, connectionState: 'warn' };
  notify();
}

/** Só para teste: reinicia o singleton do módulo entre casos. */
export function resetPainelState(overrides: Partial<PainelState> = {}): void {
  state = {
    token: '',
    refreshRateS: 10,
    payload: {},
    blockMeta: {},
    loading: false,
    error: null,
    lastSuccessAt: null,
    connectionState: 'syncing',
    ...overrides,
  };
  notify();
}

export type ToastVariant = 'ok' | 'err' | 'info';

export interface PainelToast {
  id: number;
  text: string;
  variant: ToastVariant;
}

type ToastListener = (toasts: PainelToast[]) => void;

// Fila global de toasts em canal PRÓPRIO (fora do PainelState): um toast novo
// não pode re-renderizar a página nem disputar com a notificação do poll.
const TOAST_MAX = 4;
let toasts: PainelToast[] = [];
let toastSeq = 0;
const toastListeners = new Set<ToastListener>();

function notifyToasts(): void {
  for (const listener of toastListeners) listener(toasts);
}

export function getPainelToasts(): PainelToast[] {
  return toasts;
}

export function subscribePainelToasts(listener: ToastListener): () => void {
  toastListeners.add(listener);
  return () => {
    toastListeners.delete(listener);
  };
}

/** Enfileira um toast e devolve o id (usado para fechar antes do auto-dismiss). */
export function pushPainelToast(text: string, variant: ToastVariant = 'info'): number {
  const id = ++toastSeq;
  toasts = [...toasts, { id, text, variant }];
  if (toasts.length > TOAST_MAX) toasts = toasts.slice(toasts.length - TOAST_MAX);
  notifyToasts();
  return id;
}

export function dismissPainelToast(id: number): void {
  const next = toasts.filter((toast) => toast.id !== id);
  if (next.length === toasts.length) return;
  toasts = next;
  notifyToasts();
}

/** Só para teste: reinicia a fila do singleton entre casos. */
export function resetPainelToasts(): void {
  toasts = [];
  toastSeq = 0;
  notifyToasts();
}

export function mergePainelPayload(partial: Record<string, any>): void {
  const now = Date.now();
  const nextMeta = { ...state.blockMeta };
  const nextPayload = { ...state.payload };

  for (const [key, value] of Object.entries(partial)) {
    if (key === 'generatedAt' || key === 'blocos') continue;
    nextPayload[key] = value;
    nextMeta[key] = { updatedAt: now };
  }

  state = {
    ...state,
    payload: nextPayload,
    blockMeta: nextMeta,
    error: null,
    loading: false,
    lastSuccessAt: now,
    connectionState: 'online',
  };
  notify();
}
