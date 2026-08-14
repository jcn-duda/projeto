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

module.exports = { raceWithDeadline };
