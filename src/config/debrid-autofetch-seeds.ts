import { num } from './helpers.js';

// Terceiro nível do autofetch (pool "seeds", melhor swarm), extraído de
// debrid.ts pela catraca de linhas. Espalhado DENTRO de `debrid()`: as chaves
// continuam sendo `config.debrid.autoFetch*` para todo o código e os testes.
// Fábrica pelo mesmo motivo das irmãs: cada re-avaliação do compositor relê o
// process.env.
export const autofetchSeeds = () => ({
  // Rede de segurança do terceiro nível: vale quando não há BR dublado E
  // (não há dublagem global OU o operador recusou DEBRID_AUTO_FETCH_ANY).
  // Sem isso a busca acaba sem baixar nada e, com "somente já em cache"
  // ligado, o usuário vê zero opção para sempre. O limite é separado do
  // autofetch dublado para não encher a conta com até quatro torrents só
  // porque o título não tem áudio PT (ou o operador não quis baixar o global).
  autoFetchTopSeeds: String(process.env.DEBRID_AUTO_FETCH_TOP_SEEDS || 'true') === 'true',
  autoFetchTopSeedsMax: Math.min(4, Math.max(1, Math.trunc(num(process.env.DEBRID_AUTO_FETCH_TOP_SEEDS_MAX, 2)))),
  // Um torrent com poucos pares costuma morrer na fila do debrid; abaixo de
  // três seeders o download não é uma alternativa saudável ao episódio vazio.
  autoFetchMinSeeders: Math.max(0, Math.trunc(num(process.env.DEBRID_AUTO_FETCH_MIN_SEEDERS, 3))),
  // Título RARO no pool de swarm: até THRESHOLD candidatos com pelo menos 1
  // seeder E o melhor deles abaixo de MAX_SEEDERS. Aí o limite imediato sobe de
  // TOP_SEEDS_MAX para RARE_MAX: poucas alternativas fracas, e disparar só 2
  // aposta a obra em dois torrents que podem empacar juntos. Poucos candidatos
  // com enxame saudável (59/47 seeders) terminam sozinhos — não é raro, e
  // baixar o de 1 seeder junto seria só lixo na conta. THRESHOLD=0 desliga;
  // RARE_MAX abaixo de TOP_SEEDS_MAX não tem efeito.
  autoFetchRareMax: Math.min(6, Math.max(1, Math.trunc(num(process.env.DEBRID_AUTO_FETCH_RARE_MAX, 4)))),
  autoFetchRareThreshold: Math.min(20, Math.max(0, Math.trunc(num(process.env.DEBRID_AUTO_FETCH_RARE_THRESHOLD, 6)))),
  autoFetchRareMaxSeeders: Math.max(1, Math.trunc(num(process.env.DEBRID_AUTO_FETCH_RARE_MAX_SEEDERS, 10))),
  // Preferência PT no pool de swarm: candidato com sinal de português
  // (dublado/nacional ou título que denuncia pt-BR) vence a contagem bruta
  // de seeders. É preferência, não filtro: sem nenhum candidato PT a ordem
  // por seeders continua valendo. false restaura a ordenação antiga.
  autoFetchSeedsPtFirst: String(process.env.DEBRID_AUTO_FETCH_SEEDS_PT_FIRST || 'true') === 'true',
  // Teto de tamanho do pool seeds (Fase 1 do Chupim 2.0), em GB. O seeds é o
  // ÚLTIMO recurso: baixar 60 GB de um 4K não "esquenta o play", enche a conta
  // e demora. 0 desliga o teto de tamanho (o `maxSizeGb` do usuário continua
  // valendo quando setado); tamanho desconhecido segue recusado.
  autoFetchSeedsMaxGb: Math.max(0, num(process.env.DEBRID_AUTO_FETCH_SEEDS_MAX_GB, 8)),
  // Teto de qualidade do pool seeds. 4K/2160p e REMUX/BDREMUX ficam de fora, e
  // qualidade DESCONHECIDA é recusada (não dá para provar que está no teto). A
  // normalização vive em autofetch-policy.ts; valor fora do vocabulário cai em
  // 1080p. Estático (sem tuning ao vivo nesta fase): mudar exige restart.
  autoFetchSeedsMaxQuality: String(process.env.DEBRID_AUTO_FETCH_SEEDS_MAX_QUALITY || '1080p').trim() || '1080p',
  // Exceção raro-sobre-cache (caso real Mortuary, tt0087746): com o regime raro
  // REAL e cacheCheck efetivo, aquece as alternativas frias mesmo com um global
  // não-dublado em cache. Default FALSE: qualquer cache tocável impede seeds.
  // Ligar restaura a regressão de então sob as mesmas travas (dublado em cache
  // segue abortando; hash cacheado nunca enfileira).
  autoFetchRareOverCached: String(process.env.DEBRID_AUTO_FETCH_RARE_OVER_CACHED || 'false') === 'true',
});
