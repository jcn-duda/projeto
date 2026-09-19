// Harness compartilhado dos testes da Fase 6 (evicção dirigida de fallbacks).
//
// Extraído para dois arquivos de teste caberem no teto de linhas: o de POLÍTICA
// (`autofetch-evict.test.ts`) e o de EXECUTOR/ORDEM (`autofetch-evict-executor.test.ts`).
// NÃO é um arquivo de teste — não entra no `testFiles`. Pina os knobs de
// posse/anti-reenchimento para o verde não depender do .env do operador.
import config from '../../src/config.js';
import * as cache from '../../src/utils/cache.js';
import * as metrics from '../../src/utils/metrics.js';
import { accountScope } from '../../src/utils/request-key.js';
import debrid from '../../src/debrid/index.js';
import { evictMarkerMeta } from '../../src/providers/autofetch-evict.js';
import { obraKey, type ObraEntry } from '../../src/providers/autofetch-obra.js';
import { markerKey, markerValue } from '../../src/providers/autofetch-marker.js';
import { rememberSubmitted, resetSubmittedForTests } from '../../src/debrid/alldebrid-inventory.js';
import { inventario, soltaInventario } from './alldebrid-mock.js';
import type { DebridAdapter } from '../../types/domain.js';

config.debrid.reuploadBlock = true;
config.debrid.alldebridReuploadBlockTtlMs = 3 * 24 * 3600 * 1000;
config.debrid.autoFetchProtectBr = true;
config.debrid.alldebridSubmittedTtlMs = 7 * 24 * 3600 * 1000;

export const KEY = 'chave-f6-evict';
export const ACCOUNT = accountScope(KEY);
export const IMDB = 'tt9000001';
export const identity = { adapterId: 'alldebrid', account: ACCOUNT, imdbId: IMDB, season: null, episode: null, isPack: false };

export const READY = '11'.repeat(20);
export const F_ANY = '22'.repeat(20);
export const F_SEEDS = '33'.repeat(20);
export const F_OTHER_POOL = '44'.repeat(20); // mesma obra, pool br — nunca sai
export const F_LEGACY = '55'.repeat(20); // marker legado
export const F_NO_MARKER = '5a'.repeat(20); // sem marker nenhum
export const F_NO_ADSUB = '66'.repeat(20); // marker novo, sem posse
export const F_HELD = '77'.repeat(20);
export const F_PROT = '88'.repeat(20);
export const F_YOUNG = '99'.repeat(20);
export const F_NO_DATE = '9a'.repeat(20);
export const F_OUTRA = 'ab'.repeat(20); // outra obra — fora do registro

export const adapter = debrid.BY_ID.get('alldebrid') as DebridAdapter;
export const hint = { imdbId: IMDB };

export const limpa = () => {
  cache.clearNamespace('autofetch');
  cache.clearNamespace('adrm');
  cache.clearNamespace('adprot');
  cache.clearNamespace('adsub');
  resetSubmittedForTests();
  soltaInventario(ACCOUNT);
  metrics.reset();
};

export const entry = (hash: string, pool: string, extra: Record<string, unknown> = {}): ObraEntry =>
  ({ hash, pool, acceptedAt: Date.now(), ...extra });

export const putRecord = (entries: ObraEntry[]) => cache.set(obraKey(identity), { entries }, 3600);

export const readyEntry = () => entry(READY, 'br', { br: true, dubbed: true, title: 'BR Dublado' });

export const setMarker = (hash: string, pool: string, imdbId = IMDB) => {
  const meta = evictMarkerMeta({
    adapterId: 'alldebrid', account: ACCOUNT, imdbId, season: null, episode: null, isPack: false,
    pool, title: 'x', br: pool === 'br', dubbed: pool === 'br',
  });
  cache.set(markerKey('alldebrid', ACCOUNT, hash), markerValue(true, meta), 3600);
};

export const own = (hash: string) => { inventario(ACCOUNT, []); rememberSubmitted(ACCOUNT, hash); };
