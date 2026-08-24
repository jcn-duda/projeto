'use strict';

// Map com teto de concorrência, compartilhado pelos quatro perfis. O post que
// falha vira `null` e sai do resultado em vez de derrubar o lote inteiro: um
// post sem botão é rotina nos WordPress BR, e um `Promise.all` cru perdia os
// outros N-1 por causa dele.
//
// `onError` entra por parâmetro porque só o BluDV loga o motivo — os outros
// três engolem de propósito para não poluir o log com o caso esperado.
async function mapLimit(items, limit, fn, onError) {
  const output = new Array(items.length);
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
  return output.filter(Boolean);
}

module.exports = { mapLimit };
