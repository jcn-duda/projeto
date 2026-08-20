/**
 * Disputa uma tarefa com um prazo sem cancelar o trabalho tardio. O timer sai
 * assim que um lado vence; mantê-lo vivo após o sucesso gerava aviso falso de
 * deadline e uma entrada inútil na fila de timers por busca.
 */
function raceWithDeadline(task, ms, onDeadline) {
  let timer;
  const deadline = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      try {
        resolve(onDeadline());
      } catch (err) {
        reject(err);
      }
    }, ms);
    timer.unref();
  });

  return Promise.race([Promise.resolve(task), deadline]).finally(() => clearTimeout(timer));
}

/**
 * Tempo que a checagem de cache pode consumir antes do prazo da resposta,
 * deixando `margin` ms para filtro, assinatura HMAC e serialização.
 * `null` = sem teto dinâmico (passe tardio usa o timeout completo do adaptador).
 * 0 = já venceu: quem chama degrada na hora para `known:false`.
 */
function remainingCheckBudget(deadlineAt, now = Date.now(), margin = 0) {
  if (deadlineAt == null) return null;
  return Math.max(0, deadlineAt - now - margin);
}

export { raceWithDeadline, remainingCheckBudget };
