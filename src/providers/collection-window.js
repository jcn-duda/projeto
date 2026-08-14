function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)).unref());
}

/**
 * Coleta providers até o orçamento normal. Se só chegaram fontes globais,
 * concede uma janela curta para a primeira fonte BR: o cliente exibe a primeira
 * resposta e nem toda UI repete a chamada marcada como parcial.
 */
async function collectWithinWindow(tasks, {
  budgetMs,
  priorityGraceMs = 0,
  // Quem tem fallback de balde vazio (série → pack) não pode gastar a graça
  // esperando fonte BR de uma busca que não trouxe nada: a espera sairia do
  // tempo do pack. Com itens no balde o fallback não roda e a graça é segura.
  graceRequiresItems = false,
  isPriority = (items) => items.some((item) => item?.isBr),
  onError = () => {},
  delay = wait,
} = {}) {
  const items = [];
  let done = false;
  let prioritySeen = false;
  let pendingPriority = tasks.filter((task) => task.priority).length;
  let notifyPriority;
  const priority = new Promise((resolve) => { notifyPriority = resolve; });
  let notifyPriorityDone;
  const priorityDone = new Promise((resolve) => { notifyPriorityDone = resolve; });

  const collecting = tasks.map(({ promise, priority: priorityTask }) =>
    Promise.resolve(promise)
      .then((batch = []) => {
        items.push(...batch);
        if (!prioritySeen && isPriority(batch)) {
          prioritySeen = true;
          notifyPriority();
        }
      })
      .catch(onError)
      .finally(() => {
        if (!priorityTask) return;
        pendingPriority -= 1;
        if (pendingPriority === 0) notifyPriorityDone();
      }),
  );
  const completion = Promise.all(collecting).then(() => { done = true; });

  await Promise.race([completion, delay(budgetMs)]);
  if (
    !done && !prioritySeen && pendingPriority > 0 && priorityGraceMs > 0 &&
    (!graceRequiresItems || items.length > 0)
  ) {
    await Promise.race([completion, priority, priorityDone, delay(priorityGraceMs)]);
  }

  return { items, done, completion, prioritySeen };
}

module.exports = { collectWithinWindow };
