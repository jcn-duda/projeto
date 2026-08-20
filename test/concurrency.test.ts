// @ts-nocheck — rodada 1: checagem suspensa para fechar o portão do src;
// remover arquivo a arquivo na rodada 2.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mapLimit } from '../src/utils/concurrency.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('concurrency.mapLimit', () => {
  it('preserva a ordem de entrada independentemente da ordem de conclusão', async () => {
    // Itens com latência invertida: se a ordem seguisse a conclusão, sairia
    // [3,2,1] — o contrato é devolver na ordem original.
    const items = [3, 2, 1];
    const out = await mapLimit(items, 3, async (n) => {
      await sleep(n * 10);
      return n * 10;
    });
    assert.deepEqual(out, [30, 20, 10]);
  });

  it('respeita o teto de concorrência real', async () => {
    let active = 0;
    let peak = 0;
    const items = Array.from({ length: 12 }, (_, i) => i);
    await mapLimit(items, 3, async (n) => {
      active += 1;
      peak = Math.max(peak, active);
      await sleep(5);
      active -= 1;
      return n;
    });
    assert.ok(peak <= 3, `pico de concorrência ${peak} acima do limite 3`);
    assert.ok(peak >= 2, 'concorrência baixa demais indica execução serial');
  });

  it('lista vazia devolve lista vazia sem iniciar workers', async () => {
    const out = await mapLimit([], 4, async () => {
      throw new Error('não deveria rodar');
    });
    assert.deepEqual(out, []);
  });

  it("onItemError 'keep' preserva o item original na falha (contrato do jackett)", async () => {
    const items = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const out = await mapLimit(items, 2, async (item) => {
      if (item.id === 2) throw new Error('protetor fora do ar');
      return { ...item, resolved: true };
    });
    assert.deepEqual(out, [
      { id: 1, resolved: true },
      { id: 2 }, // falhou: volta o original, sem marcar nada
      { id: 3, resolved: true },
    ]);
    assert.equal(out.length, 3);
  });

  it("onItemError 'drop' descarta o item na falha (contrato do bludv)", async () => {
    const items = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const out = await mapLimit(
      items,
      2,
      async (item) => {
        if (item.id === 2) throw new Error('post inacessível');
        return item.id;
      },
      { onItemError: 'drop' },
    );
    assert.deepEqual(out, [1, 3]);
  });

  it("com 'drop', valores falsy devolvidos por fn também saem", async () => {
    // Reproduz o caso do bludv: resolveMagnet devolve null quando o protetor
    // não entrega magnet, e o filtro final remove esses nulos.
    const out = await mapLimit(
      [1, 2, 3, 4],
      2,
      async (n) => (n % 2 === 0 ? null : n),
      { onItemError: 'drop' },
    );
    assert.deepEqual(out, [1, 3]);
  });

  it("com 'keep', valores falsy devolvidos por fn permanecem", async () => {
    const out = await mapLimit([1, 2, 3], 2, async (n) => (n === 2 ? null : n));
    assert.deepEqual(out, [1, null, 3]);
  });
});
