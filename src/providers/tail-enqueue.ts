/**
 * Fila serial genérica para trabalho tardio (fora do caminho da resposta).
 * Extraída verbatim de `search-orchestrator.ts`: refresh de debrid e varredura
 * pt-BR compartilham uma única fila para não executar `applyDebrid`/upload
 * concorrentes na mesma chave. Cada task roda num `setImmediate` não-bloqueante
 * (`unref`) encadeado ao anterior; um task sem try/catch próprio é engolido
 * aqui em vez de derrubar o processo. Retorna a promise da fila já com o task
 * enfileirado — quem precisa aguardar a barreira usa o retorno.
 */
import * as log from '../utils/logger.js';

export function createTailQueue() {
  let tail = Promise.resolve();
  return (task: () => any) => {
    tail = tail.then(() => new Promise((resolve) => {
      const handle = setImmediate(async () => {
        try {
          await task();
        } catch (err) {
          // A fila é genérica: um task sem try/catch próprio derrubaria o processo.
          log.warn('[search] tarefa tardia falhou:', err?.message || err);
        } finally {
          resolve();
        }
      });
      handle.unref();
    }));
    return tail;
  };
}
