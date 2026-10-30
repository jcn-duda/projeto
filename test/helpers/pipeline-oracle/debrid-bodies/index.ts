/**
 * Corpos TS de `checkCached`/`resolveLink` dos adaptadores, para o oráculo de
 * paridade. Saíram de `src/debrid/`: em produção a checagem e o link são
 * sempre da ponte nativa (`wrap` em `rust-remote.ts`).
 *
 * Só o que NÃO está em `src/`: o `checkCached` de Premiumize e TorBox fica lá
 * (o `liveCheck` de /stream-trace.json usa o GET cru de `BY_ID`), então o mapa
 * não o traz — `rawAdapter()` mantém o método de `BY_ID` quando existe.
 */
import type { DebridAdapter } from '../../../../types/domain.js';
import { bodies as premiumize } from './premiumize.js';
import { bodies as torbox } from './torbox.js';
import { bodies as realdebrid } from './realdebrid.js';
import { bodies as debridlink } from './debridlink.js';
import { bodies as alldebrid } from './alldebrid.js';

// Também o lado de AUTOFETCH (enqueue/status/remoção/inventário): o worker
// nativo do Chupim é o dono em produção, então esses corpos TS saíram de
// `src/debrid/` e entram aqui por serviço.
type Bodies = Partial<Pick<
  DebridAdapter,
  'checkCached' | 'resolveLink' | 'enqueue' | 'torrentStatus' | 'removeTorrent' | 'inventory'
>>;

const BY_SERVICE = new Map<string, Bodies>([
  ['premiumize', premiumize],
  ['torbox', torbox],
  ['realdebrid', realdebrid],
  ['debridlink', debridlink],
  ['alldebrid', alldebrid],
]);

/** Corpos TS do serviço; objeto vazio para um id sem corpos conhecidos. */
export function bodiesFor(id: string): Bodies {
  return BY_SERVICE.get(id) ?? {};
}

/** O adaptador com os corpos TS por baixo: método do próprio objeto (mock de teste) vence. */
export function withBodies<T extends DebridAdapter>(adapter: T): T {
  return { ...bodiesFor(adapter.id), ...adapter };
}
