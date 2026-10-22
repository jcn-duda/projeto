// Gate de disponibilidade do oráculo externo do Real-Debrid.
//
// O DESPACHANTE (`check`) saiu na Fase 1 do corte "mais Rust, menos TS": seu
// único chamador era o `applyDebrid`, que deixou o `src/` no F4.4 — a cópia viva
// é o oráculo congelado de `test/helpers/pipeline-oracle/`. Nada em produção
// consulta StremThru/Torrentio pelo TS; a decisão de cache do RD é do núcleo.
//
// O que SOBRA é o gate que o `registry` consulta para decidir se o RD pode
// prometer `cacheCheck` dinâmico. Puro, sem rede: só lê a config efetiva.
import config from '../config.js';

/**
 * True se ao menos uma fonte está de fato utilizável com credencial efetiva.
 *
 * Exige: oráculo ligado E um endpoint configurado E (token/key explícitos da
 * fonte OU apiKey efetiva da instalação). Sem credencial alguma, nenhuma fonte
 * responde pela conta → `false` (RD continua honesto "não sei"). Apesar do
 * nome, o flag do `current()` é por requisição (víamos o `debridApiKey`); não
 * chame sem passar a chave quando ela existir no contexto.
 */
export function available(apiKey?: string): boolean {
  if (!config.debrid.rdOracle.enabled) return false;
  const { stremthruUrl, stremthruToken, torrentio, torrentioKey, torrentioUrl } = config.debrid.rdOracle;
  const stremthruLive = Boolean(stremthruUrl) && Boolean(stremthruToken || apiKey);
  const torrentioLive = Boolean(torrentioUrl && torrentio) && Boolean(torrentioKey || apiKey);
  return stremthruLive || torrentioLive;
}
