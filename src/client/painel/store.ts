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

let state: PainelState = {
  token: typeof localStorage !== 'undefined' ? localStorage.getItem('adom.dashboard.test-token') || '' : '',
  refreshRateS: typeof localStorage !== 'undefined' ? Number(localStorage.getItem('adom.dashboard.refresh-rate') || 10) : 10,
  payload: {},
  blockMeta: {},
  loading: false,
  error: null,
  lastSuccessAt: null,
  connectionState: 'syncing',
};

const listeners = new Set<Listener>();

export function getPainelState(): PainelState {
  return state;
}

export function subscribePainelState(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function notify(): void {
  for (const listener of listeners) {
    listener(state);
  }
}

export function setPainelToken(token: string): void {
  state = { ...state, token };
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem('adom.dashboard.test-token', token);
  }
  notify();
}

export function setPainelRefreshRate(refreshRateS: number): void {
  state = { ...state, refreshRateS };
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem('adom.dashboard.refresh-rate', String(refreshRateS));
  }
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
