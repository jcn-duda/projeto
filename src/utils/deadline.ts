/**
 * Disputa uma tarefa com um prazo sem cancelar o trabalho tardio. O timer sai
 * assim que um lado vence; mantê-lo vivo após o sucesso gerava aviso falso de
 * deadline e uma entrada inútil na fila de timers por busca.
 */
function raceWithDeadline<T, F = T>(task: Promise<T>, ms: number, onDeadline: () => F): Promise<T | F> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<F>((resolve, reject) => {
    timer = setTimeout(() => {
      try {
        resolve(onDeadline());
      } catch (err) {
        reject(err);
      }
    }, ms);
    timer?.unref();
  });

  return Promise.race([Promise.resolve(task), deadline]).finally(() => clearTimeout(timer));
}

/**
 * Tempo que a checagem de cache pode consumir antes do prazo da resposta,
 * deixando `margin` ms para filtro, assinatura HMAC e serialização.
 * `null` = sem teto dinâmico (passe tardio usa o timeout completo do adaptador).
 * 0 = já venceu: quem chama degrada na hora para `known:false`.
 */
function remainingCheckBudget(deadlineAt: number | null | undefined, now = Date.now(), margin = 0) {
  if (deadlineAt == null) return null;
  return Math.max(0, deadlineAt - now - margin);
}

/**
 * `fetch` + corpo JSON sob um prazo DURO. O `AbortSignal.timeout` sozinho não
 * bastou: no Docker local (2026-09-30) 8 consultas à Cinemeta ficaram
 * pendentes para sempre com ele no `fetch`, e como a promessa mora no
 * `inFlight` do `getMeta`, a obra inteira travou em "Procurando fontes" até o
 * restart. Aqui o timer é nosso: aborta o controller E rejeita a corrida, então
 * a promessa sempre termina, mesmo que o abort não chegue ao socket.
 */
async function fetchJsonWithin(
  url: string | URL,
  init: RequestInit,
  ms: number,
): Promise<{ res: Response; data: any }> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const hard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error('The operation was aborted due to timeout');
      err.name = 'TimeoutError';
      controller.abort(err);
      reject(err);
    }, Math.max(1, ms));
  });
  const work = (async () => {
    const res = await fetch(url, { ...init, signal: controller.signal });
    return { res, data: res.ok ? await res.json() : null };
  })();
  // A corrida perdida ainda pode rejeitar depois: sem este catch ela vira
  // unhandledRejection.
  work.catch(() => {});
  try {
    return await Promise.race([work, hard]);
  } finally {
    clearTimeout(timer);
  }
}

export { raceWithDeadline, remainingCheckBudget, fetchJsonWithin };
