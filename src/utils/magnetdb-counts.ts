// Formato da chave do banco de magnets e reconstrução das contagens a partir
// do L1. Módulo separado do magnetdb.ts por dois motivos: aquele arquivo está
// no teto de 400 linhas, e quem faz o parse não pode depender dele — o
// magnetdb importa daqui na inicialização, e o magnetdb-inspect importa dos
// dois. A dependência é de mão única (cache + cache-keys) de propósito.
//
// Segurança de payload: a chave carrega o DIGEST da conta entre adapterId e
// hash. O parse DESCARTA esse token na origem: nada aqui devolve credencial,
// e o hash devolvido é o do conteúdo (40-hex).
import * as cache from './cache.js';
import { prefix } from './cache-keys.js';

export const MAG_SIDES = ['alive', 'bad', 'lie'] as const;
export type MagSide = (typeof MAG_SIDES)[number];

export type AdapterTotals = {
  alive: number; bad: number; lie: number;
  // Aproximação operacional: renovações e remoções subtraem o TTL nominal,
  // não o restante exato de cada chave. As contagens são exatas; esta soma
  // serve apenas para mostrar uma média conservadora no painel sem scan O(n).
  // A reconstrução abaixo é a exceção: ela lê o restante real de cada chave.
  ttlRemainingSums: { alive: number; bad: number; lie: number };
};

export type ParsedMagKey = { adapterId: string; side: MagSide; hash: string };

const HASH_RE = /^[a-f0-9]{40}$/;

/**
 * `mag:v1:<side>:<adapterId>:<scope>:<hash>` — o scope (digest SHA-256 da
 * apiKey) é o token descartado. Formato inválido devolve null (chave legada
 * ou estranha no namespace não derruba a varredura).
 */
export function parseMagKey(key: string, base: string = prefix('mag')): ParsedMagKey | null {
  const parts = key.slice(base.length).split(':');
  if (parts.length !== 4) return null;
  const [side, adapterId, , hash] = parts;
  const typed = side as MagSide;
  if (!(MAG_SIDES as readonly string[]).includes(typed)) return null;
  if (!adapterId || !HASH_RE.test(hash)) return null;
  return { adapterId, side: typed, hash };
}

export function emptyAdapterTotals(): AdapterTotals {
  return { alive: 0, bad: 0, lie: 0, ttlRemainingSums: { alive: 0, bad: 0, lie: 0 } };
}

/**
 * Recontagem O(namespace mag) direto do L1, para quando o agregado persistido
 * não abre (primeiro boot com cache.db herdado, chave evictada, payload de
 * versão estranha). Sem isto o painel afirmaria `_origem: 'duravel'` mostrando
 * zero com o L1 cheio — pior que um número aproximado, porque parece medido.
 *
 * Roda uma vez na inicialização (e no autocura do status()), não no caminho de
 * busca. O TTL somado aqui é o restante REAL de cada chave, via peekRemaining:
 * leitura sem efeito, não promove LRU nem conta hit/miss.
 */
export function rebuildFromL1(): Map<string, AdapterTotals> {
  const base = prefix('mag');
  const out = new Map<string, AdapterTotals>();
  for (const key of cache.keysMatching(base)) {
    const parsed = parseMagKey(key, base);
    if (!parsed) continue;
    let totals = out.get(parsed.adapterId);
    if (!totals) {
      totals = emptyAdapterTotals();
      out.set(parsed.adapterId, totals);
    }
    totals[parsed.side] += 1;
    totals.ttlRemainingSums[parsed.side] += Math.max(0, cache.peekRemaining(key) || 0);
  }
  return out;
}
