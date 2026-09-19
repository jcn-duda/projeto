// P1.1 da auditoria adversarial: a decisão de overflow de upgrade precisa ver
// as reservas PENDING vivas (com a qualidade delas). Sem isso, uma faixa-alvo
// recém-reservada e ainda não commitada não bloqueava a duplicata, e um segundo
// hash da MESMA faixa ganhava o slot cap+1. Sem rede.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

import autofetchLive from '../src/utils/autofetch-live.js';
import { accountScope } from '../src/utils/request-key.js';
import { reserveObra, commitObra, resetObraForTest } from '../src/providers/autofetch-obra.js';

const PM = 'premiumize';
const hx = (seed: string) => seed.repeat(40).slice(0, 40);

function identity(apiKey: string, o: { imdbId?: string | null; season?: number | null; episode?: number | null } = {}) {
  return {
    adapterId: PM, account: accountScope(apiKey),
    imdbId: o.imdbId ?? null, season: o.season ?? null, episode: o.episode ?? null, searchKey: null,
  };
}

test('overflow de upgrade conta reservas PENDING: faixa pendente bloqueia a duplicata', () => {
  const apiKey = 'chave-obra-pending-ov';
  const o = { imdbId: 'tt7000012', season: 1, episode: 1 };
  autofetchLive.set({ autoFetchMax: 3 });
  const lows = [hx('e0'), hx('e1')];
  const first1080 = hx('e2');
  const second1080 = hx('e3');
  try {
    for (const hash of lows) {
      const lease = reserveObra({ ...identity(apiKey, o), pool: 'br', hash, quality: '720p' });
      assert.ok(lease, 'cap 3 ainda tinha vaga');
      commitObra(lease, { hash, pool: 'br', quality: '720p' });
    }
    // 2 commitados (720p) + 1 reserva 1080p PENDENTE (sem commit) = cap cheio.
    const reserva = reserveObra({ ...identity(apiKey, o), pool: 'br', hash: first1080, quality: '1080p' });
    assert.ok(reserva, 'primeiro 1080p entra normal (2 < 3) e fica pendente');
    // A duplicata da faixa que está PENDENTE não pode ganhar o cap+1: reserva
    // viva é vaga ocupada, com a qualidade dela.
    assert.equal(
      reserveObra({ ...identity(apiKey, o), pool: 'br', hash: second1080, quality: '1080p' }),
      null,
      '1080p pendente bloqueia a duplicata que a decisão antiga (só registro) deixava passar',
    );

    // O overflow segue funcionando quando a faixa-alvo está ausente no registro
    // E nas pendentes: outra obra com 3 baixos commitados aceita o 1080p extra.
    const o2 = { imdbId: 'tt7000013' };
    for (const hash of [hx('e5'), hx('e6'), hx('e7')]) {
      const lease = reserveObra({ ...identity(apiKey, o2), pool: 'br', hash, quality: '720p' });
      assert.ok(lease);
      commitObra(lease, { hash, pool: 'br', quality: '720p' });
    }
    const ov = reserveObra({ ...identity(apiKey, o2), pool: 'br', hash: hx('e8'), quality: '1080p' });
    assert.ok(ov, '1080p ausente em registro e pendentes abre a reserva extra');
    assert.equal(ov?.overflow, true, 'marcada como overflow');
  } finally {
    autofetchLive.reset();
    resetObraForTest();
  }
});
