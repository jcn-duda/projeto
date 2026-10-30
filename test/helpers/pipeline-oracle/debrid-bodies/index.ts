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

type Bodies = Partial<Pick<DebridAdapter, 'checkCached' | 'resolveLink'>>;

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
