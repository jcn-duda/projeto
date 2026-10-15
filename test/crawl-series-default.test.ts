// A raspagem tem que cobrir FILME E SÉRIE. Este arquivo fixa o DEFAULT dessa
// promessa (`CRAWL_SERIES_ENABLED`), que é onde ela se quebrava: a chave existia
// desde a Fase 7, mas nascia `'false'`, e o `.env` de instalação não tem chave
// `CRAWL_` nenhuma — então o motor rodava em filme puro, e o silêncio de
// "série desligada" era indistinguível de "site sem série".
//
// O toggle por site NÃO é deste arquivo: ele é testado em
// `crawl-series-veto2.test.ts` (veto ligado/desligado chegando ao `discover`) e
// em `crawl-series-rate.test.ts` (tetos). Aqui é o default e a PROPAGAÇÃO dele,
// que é o que a virada de chave podia ter deixado para trás.
//
// `config.crawl` é um OBJETO avaliado no import (não função), então o ambiente
// já está lido quando este arquivo roda. Por isso o teste é escrito contra o
// ambiente real: ele afirma o valor que o motor Effective vai ler, seja ele o
// default (chave ausente) ou o que a chave diz. O que ele proíbe é o
// incoerente — `CRAWL_SERIES_ENABLED=false` no ambiente com série ligada.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import config from '../src/config.js';
import { envDefaults, schema, seriesLimitsOf } from '../src/utils/crawler-live-schema.js';

const ENV_KEY = 'CRAWL_SERIES_ENABLED';
/** O que a chave do ambiente, se existir, manda — a mesma regra do config. */
const esperadoDoEnv = process.env[ENV_KEY] === undefined ? true : process.env[ENV_KEY] === 'true';

describe('crawl séries: default ligado', () => {
  test('sem a chave no ambiente, séries entram na raspagem', () => {
    if (process.env[ENV_KEY] !== undefined) {
      // Ambiente com a chave presente: o contrato é outro (o do operador), e o
      // teste abaixo de propagação continua valendo. Não há o que afirmar aqui.
      return;
    }
    assert.equal(config.crawl.seriesEnabled, true, 'filme E série é o contrato do motor');
  });

  test('o valor efetivo é coerente com a chave do ambiente', () => {
    assert.equal(
      config.crawl.seriesEnabled,
      esperadoDoEnv,
      'a chave continua decide o valor; ela é que deixou de nascer desligada',
    );
  });

  test('desligar série não desliga filme: são eixos independentes', () => {
    // A série é um EIXO do acervo, não um modo do motor. Desligá-la não pode
    // mexer no teto por hora nem no custo da descoberta de filme, que é o que
    // alimenta a rodada inteira.
    assert.ok(config.crawl.discoveryCost > 0, 'a descoberta de filme continua cobrando custo');
    assert.ok(config.crawl.maxPerHour > 0, 'o teto por hora é do motor, não da série');
  });

  test('o default chega ao discover e ao fetchWork como enabled', () => {
    // O motor tira os três campos de UM snapshot só (`crawl-step.ts` repassa o
    // mesmo `seriesLimitsOf(cfg)` ao `discover` e ao `processCrawlPage`). Se o
    // default não sobreviver a essa derivação, a virada de chave é letra morta.
    const limites = seriesLimitsOf(envDefaults());
    assert.equal(limites.enabled, config.crawl.seriesEnabled, 'o snapshot entrega o que a config diz');
    assert.equal(limites.maxCards, config.crawl.seriesMaxCards);
    assert.equal(limites.maxButtons, config.crawl.seriesMaxButtons);
  });

  test('a doc do painel descreve série como ligada, não como "desligue para ter série"', () => {
    // O texto do toggle é o que o operador lê antes de mexer; ele não pode
    // descrever um estado que o default não tem mais.
    const campo = schema().find((c) => c.key === 'seriesEnabled');
    assert.ok(campo, 'o toggle de séries continua no schema do painel');
    assert.equal(campo.envDefault, config.crawl.seriesEnabled, 'o padrão mostrado é o default real');
  });
});
