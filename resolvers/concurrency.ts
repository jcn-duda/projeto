// Map com teto de concorrência, compartilhado pelos seis perfis. O post que
// falha vira `null` e sai do resultado em vez de derrubar o lote inteiro: um
// post sem botão é rotina nos WordPress BR, e um `Promise.all` cru perdia os
// outros N-1 por causa dele.
//
// `onError` entra por parâmetro porque só o BluDV loga o motivo — os outros
// três engolem de propósito para não poluir o log com o caso esperado.
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
  onError?: ((err: unknown, item: T) => void) | null,
): Promise<R[]> {
  const output: Array<R | null> = new Array(items.length).fill(null);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      try {
        output[index] = await fn(items[index]);
      } catch (err) {
        if (onError) onError(err, items[index]);
        output[index] = null;
      }
    }
  });
  await Promise.all(workers);
  // `Boolean` preserva o contrato histórico (qualquer valor falsy sai) e o
  // predicado devolve o tipo sem cast.
  return output.filter((value): value is R => Boolean(value));
}

export { mapLimit };
