function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)).unref());
}

interface CollectWindowOptions {
  budgetMs?: number;
  priorityGraceMs?: number;
  graceRequiresItems?: boolean;
  isPriority?: (items: any[]) => boolean;
  /**
   * Parada antecipada: quando devolve true para um lote recém-chegado, a
   * resposta sai NA HORA com o que há no balde e as tarefas restantes continuam
   * em fundo (`completion` segue viva — quem promove o lote completo é o passe
   * tardio de sempre). É o fast-path da conta: fonte instantânea suficiente
   * não pode esperar indexer lento que ninguém precisa mais.
   */
  stopWhen?: (batch: any[], items: any[], meta: { priority?: boolean; source?: string }) => boolean;
  onError?: (err: any) => void;
  onBatch?: (batch: any[], items: any[], meta: { priority?: boolean; source?: string }) => void;
  delay?: (ms: number) => Promise<unknown>;
}

/**
 * Coleta providers até o orçamento normal. Se só chegaram fontes globais,
 * concede uma janela curta para a primeira fonte BR: o cliente exibe a primeira
 * resposta e nem toda UI repete a chamada marcada como parcial.
 */
async function collectWithinWindow(tasks: { promise: Promise<any>; priority?: boolean; source?: string }[], {
  budgetMs,
  priorityGraceMs = 0,
  // Quem tem fallback de balde vazio (série → pack) não pode gastar a graça
  // esperando fonte BR de uma busca que não trouxe nada: a espera sairia do
  // tempo do pack. Com itens no balde o fallback não roda e a graça é segura.
  graceRequiresItems = false,
  isPriority = (items) => items.some((item) => item?.isBr),
  stopWhen,
  onError = () => {},
  onBatch = () => {},
  delay = wait,
}: CollectWindowOptions = {}) {
  const items: any[] = [];
  let done = false;
  let stoppedEarly = false;
  let prioritySeen = false;
  let pendingPriority = tasks.filter((task) => task.priority).length;
  let notifyPriority: () => void = () => {};
  const priority = new Promise<void>((resolve) => { notifyPriority = resolve; });
  let notifyPriorityDone: () => void = () => {};
  const priorityDone = new Promise<void>((resolve) => { notifyPriorityDone = resolve; });
  let notifyStop: () => void = () => {};
  const stop = new Promise<void>((resolve) => { notifyStop = resolve; });

  const collecting = tasks.map(({ promise, priority: priorityTask, source }) =>
    Promise.resolve(promise)
      .then((batch = []) => {
        items.push(...batch);
        const meta = { priority: priorityTask, source };
        onBatch(batch, items, meta);
        if (!prioritySeen && isPriority(batch)) {
          prioritySeen = true;
          notifyPriority();
        }
        if (!done && !stoppedEarly && stopWhen?.(batch, items, meta)) {
          stoppedEarly = true;
          notifyStop();
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

  // `budgetMs` é obrigatório na prática; o default `{}` só existe para chamadas
  // vazias. O cast reflete que todo chamador real fornece o número.
  await Promise.race([completion, stop, delay(budgetMs as number)]);
  if (
    !done && !stoppedEarly && !prioritySeen && pendingPriority > 0 && priorityGraceMs > 0 &&
    (!graceRequiresItems || items.length > 0)
  ) {
    await Promise.race([completion, stop, priority, priorityDone, delay(priorityGraceMs)]);
  }

  return { items, done, completion, prioritySeen, stoppedEarly };
}

export { collectWithinWindow };
