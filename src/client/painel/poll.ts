import { getPainelState, setPainelLoading, setPainelError, mergePainelPayload } from './store.js';
import { fetchStatus } from './api.js';

export const VITAL_BLOCKS = ['general', 'debrid', 'conta', 'gate', 'harvest', 'autofetch', 'f3', 'metrics', 'cache', 'catalog', 'magnetdb'];

let inFlight = false;
let timerId: any = null;

export async function pollOnce(blocos: string[] = VITAL_BLOCKS): Promise<void> {
  const state = getPainelState();
  if (!state.token) return;
  if (inFlight) return; // Fila de 1 slot: descarta sobreposição para evitar 429 do gate

  inFlight = true;
  setPainelLoading(true);

  try {
    const res = await fetchStatus(state.token, blocos);
    if (res.ok) {
      mergePainelPayload(res.data);
    } else {
      // No 429, preserva os dados existentes e apenas sinaliza no erro se necessário
      if (res.status === 429) {
        setPainelLoading(false);
      } else {
        setPainelError(res.error);
      }
    }
  } finally {
    inFlight = false;
  }
}

export function startPolling(blocos: string[] = VITAL_BLOCKS): () => void {
  stopPolling();
  void pollOnce(blocos);

  const state = getPainelState();
  const intervalMs = Math.max(3000, (state.refreshRateS || 10) * 1000);

  timerId = setInterval(() => {
    void pollOnce(blocos);
  }, intervalMs);

  return stopPolling;
}

export function stopPolling(): void {
  if (timerId != null) {
    clearInterval(timerId);
    timerId = null;
  }
}
