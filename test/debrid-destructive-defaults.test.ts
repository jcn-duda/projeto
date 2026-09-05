// P3 — Convenção de repositório: knob que APAGA da conta nasce DESLIGADO.
//
// O incidente que fixa a regra: `bdf00ea` chegou com DEBRID_RECONCILE default
// ON e push é deploy automático (cron de 5 min) — ele teria começado a apagar
// de uma conta real cinco minutos depois do push. Só não aconteceu porque a
// assimetria foi notada na leitura do diff; `d6442b1` reverteu o default.
//
// Este teste é o portão que falta: quem adiciona um knob destrutivo novo TEM
// que declarar a intenção aqui — ou ele nasce OFF (regra), ou entra numa das
// duas listas de exceção com o porquê no comentário (que a revisão lê).
//
// TRÊS classes, com critério explícito:
//   1. destrutivo OFF     — o default apaga/mexe na conta de terceiros sem
//                           evidência prévia; ligar é decisão do operador;
//   2. destrutivo ON      — apaga POR DESIGN e o default ON é o conserto de
//                           um vazamento medido; a exceção tem rationale;
//   3. protetivo ON       — o flip para OFF é o lado destrutivo (desliga a
//                           proteção de acervo); nascer desligado é o acidente.
//
// `cachedOnly` NÃO entra: corta LISTA (o que o usuário vê), nunca apaga da
// conta — a suíte inclusive o pina em false em setup-env.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { debrid } from '../src/config/debrid.js';

/**
 * Lê o DEFAULT do knob com o ambiente limpo. O config lê o `.env` do operador
 * (dotenv) — o verde da suíte não pode depender de quem roda, então deleta
 * todo DEBRID_* antes de instanciar a fábrica, que re-lê o env a cada chamada
 * (mesmo padrão do teste do reconcile).
 */
function defaultsDe () {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('DEBRID_')) delete process.env[key];
  }
  return debrid();
}

test('Convenção: knobs que apagam da conta nascem DESLIGADOS', () => {
  const d = defaultsDe();
  assert.equal(
    d.evictPerSearch, false,
    'DEBRID_EVICT_PER_SEARCH (8.16): evicção por busca apaga magnets a cada checagem; nasce OFF',
  );
  assert.equal(
    d.reconcile, false,
    'DEBRID_RECONCILE (8.17): apagar posse órfã "pronta" sem eco da busca é destrutivo; ' +
    'nasce OFF (incidente bdf00ea→d6442b1) e liga só após janela de observação',
  );
});

test('Exceção declarada: limpezas ON por design — cada uma conserte um vazamento medido', () => {
  const d = defaultsDe();
  assert.equal(
    d.dropUncached, true,
    'dropUncached: sem ela cada busca deixa download fantasma na conta (a checagem da ' +
    'AllDebrid É um upload — apagar o não-pronto é o preço de checar). Travas: held/' +
    'knownBefore/fail-safe do snapshot null',
  );
  assert.equal(
    d.dropReady, true,
    'dropReady: sem ela cada busca deixava dezenas de magnets prontos para sempre ' +
    '(medido: 2300 magnets em 4 dias até estourar o teto). Apagar o pronto é seguro: ' +
    'o cache é do SERVIÇO, não da conta',
  );
  assert.equal(
    d.sweepDead, true,
    'sweepDead: estado terminal não é escolha de ninguém — NÃO poupa o inventário do ' +
    'usuário de propósito. Sem ela, mortos ocupam vaga até o /magnet/delete virar 503',
  );
  assert.equal(
    d.sweepUndubbed, true,
    'sweepUndubbed: legenda/estrangeiro que o autofetch acumulou, com travas próprias ' +
    '(idade mínima, held, inventário frio pula a rodada)',
  );
});

test('Protetivos: o flip para OFF é o lado destrutivo — nascem LIGADOS', () => {
  const d = defaultsDe();
  assert.equal(
    d.reuploadBlock, true,
    'DEBRID_REUPLOAD_BLOCK (8.14): sem o adrm, a busca seguinte re-subia o gringo que ' +
    'acabara de sair (cache de 900s) — limpeza virava esteira',
  );
  assert.equal(
    d.autoFetchProtectBr, true,
    'DEBRID_AUTO_FETCH_PROTECT_BR (adprot): sem retenção durável, o dropReady da busca ' +
    'seguinte apagava exatamente o BR dublado que o autofetch subiu',
  );
});

test('A convenção é sobre o DEFAULT: o operador continua podendo ligar por env', () => {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('DEBRID_')) delete process.env[key];
  }
  try {
    process.env.DEBRID_RECONCILE = 'true';
    assert.equal(debrid().reconcile, true, 'override explícito do operador vale');
    delete process.env.DEBRID_RECONCILE;
    process.env.DEBRID_EVICT_PER_SEARCH = 'true';
    assert.equal(debrid().evictPerSearch, true, 'override explícito do operador vale');
  } finally {
    delete process.env.DEBRID_RECONCILE;
    delete process.env.DEBRID_EVICT_PER_SEARCH;
  }
});
