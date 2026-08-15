/**
 * mapLimit com concorrência limitada preservando a ordem de entrada.
 *
 * `onItemError` codifica o contrato de cada caller — antes existiam duas
 * cópias divergentes (jackett.js e bludv.js):
 * - 'keep': na falha preserva o item original (jackett: a release sem magnet
 *   resolvido ainda entra com o downloadUrl, e cortar aqui a perderia);
 * - 'drop': na falha descarta o item (bludv: sem magnet não há o que exibir).
 * Com 'drop' também saem os valores falsy devolvidos por `fn`.
 */
async function mapLimit(items, limit, fn, { onItemError = 'keep' } = {}) {
  const output = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      try {
        output[index] = await fn(items[index]);
      } catch (error) {
        output[index] = onItemError === 'keep' ? items[index] : null;
      }
    }
  });
  await Promise.all(workers);
  return onItemError === 'drop' ? output.filter(Boolean) : output;
}

module.exports = { mapLimit };
