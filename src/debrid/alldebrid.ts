/**
 * Fachada do adaptador AllDebrid.
 *
 * Dividida por fronteiras reais do arquivo original (PLANO_MELHORIAS §5.8,
 * item 7 do backlog da Fase 2 — teto de 400 linhas por arquivo), preservando
 * a superfície pública EXATA: o registry (`src/debrid/registry.ts`) continua
 * fazendo `{ ...alldebrid }` e nenhuma rota/teste muda.
 *
 *   - `alldebrid-api.ts`        base HTTP (`call`), tipos, visões de conta;
 *   - `alldebrid-inventory.ts`  DONO do estado `knownBefore`/`submitted`;
 *   - `alldebrid-cleanup.ts`    limpeza: skipCleanup (o `deleteMagnets` saiu: oráculo).
 *
 * `enqueue`, `torrentStatus` e `removeTorrent` (autofetch) SAÍRAM de `src/`:
 * quem os executa é o worker nativo do Chupim, e o corpo TS mora no oráculo
 * (`test/helpers/pipeline-oracle/debrid-bodies/alldebrid-autofetch.ts`). Não
 * reintroduza o re-export nem o `alldebrid-play.ts`.
 *
 * `checkCached` e `resolveLink` NÃO são reexportados: a checagem e o play são
 * nativos (`adom-debrid`, ponte em `rust-remote.ts`), e o corpo TS que ainda
 * serve de régua mora no oráculo `test/helpers/pipeline-oracle/debrid-bodies/alldebrid.ts`.
 *
 * A evicção de fallback SAIU daqui: quem apaga hoje é o passo nativo
 * `evict_job.rs`, que só remove com os quatro fatos provados. O método opcional
 * `evictFallbacks` do `DebridAdapter` fica sem implementação de propósito —
 * `autofetch-evict.ts` lê a ausência e não tenta evictar (nada é apagado por
 * omissão). Não reintroduza o re-export: o corpo TS do evict morre na leva de
 * remoção.
 *
 * O grafo é sem ciclo: todos os irmãos importam só da base e do inventário;
 * a identidade (`id`) mora na base porque a limpeza fala com `protected.ts`.
 */
export {
  id,
  accountStatus,
  inventory,
} from './alldebrid-api.js';
export type { AllDebridMagnetRow } from './alldebrid-api.js';
export { hasDurableOwnership } from './alldebrid-inventory.js';

export const label = 'AllDebrid';
export const short = 'AD';
// Não pelo /magnet/instant (removido), e sim pelo `ready` do /magnet/upload.
export const cacheCheck = true;
// A consulta cria transferência; ela disputa o prazo sem ser abortada e segue
// em background para ler os ids e remover os magnets que não estavam prontos.
export const abortSafeCacheCheck = false;
export const keyUrl = 'https://alldebrid.com/apikeys';
