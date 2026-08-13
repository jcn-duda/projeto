const { test } = require('node:test');
const assert = require('node:assert');

// O lote de checagem de cache é o ponto onde "não perguntei" virava "não tem":
// com `cachedOnly`, um lote perdido no timeout apagava 100 streams da lista,
// inclusive fontes BR que ESTAVAM em cache no serviço.
const { batched } = require('../src/debrid/common');

const hashes = (n, prefix = 'h') => Array.from({ length: n }, (_, i) => `${prefix}${i}`);

test('todos os lotes respondem: completo, com o Set inteiro', async () => {
  const { cached, complete } = await batched(hashes(5), 2, async (batch) => batch);
  assert.equal(complete, true);
  assert.deepEqual([...cached].sort(), hashes(5).sort());
});

test('um lote que falha marca a resposta como incompleta', async () => {
  const { cached, complete } = await batched(hashes(4), 2, async (batch) => {
    if (batch.includes('h0')) throw new Error('timeout');
    return batch;
  });
  // O que respondeu continua valendo — dá pra marcar o ⚡ de quem foi confirmado.
  assert.deepEqual([...cached].sort(), ['h2', 'h3']);
  // Mas quem não foi perguntado NÃO pode ser tratado como fora do cache.
  assert.equal(complete, false);
});

test('todos os lotes falhando sobe erro em vez de dizer "nada em cache"', async () => {
  await assert.rejects(
    () => batched(hashes(4), 2, async () => { throw new Error('token inválido'); }),
    /nenhum lote/,
  );
});

test('lista vazia não vira falha', async () => {
  const { cached, complete } = await batched([], 100, async (batch) => batch);
  assert.equal(cached.size, 0);
  assert.equal(complete, true);
});

test('os lotes vão em paralelo, não em série', async () => {
  // Em série, dois lotes somavam dois timeouts inteiros (6s + 6s) contra um
  // REPLY_DEADLINE de 8,5s e a busca voltava vazia mesmo com tudo coletado.
  let running = 0;
  let peak = 0;
  await batched(hashes(6), 2, async (batch) => {
    running += 1;
    peak = Math.max(peak, running);
    await new Promise((resolve) => setTimeout(resolve, 20));
    running -= 1;
    return batch;
  });
  assert.equal(peak, 3);
});
