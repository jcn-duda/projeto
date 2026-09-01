// P5 Fatia A — recompute OFFLINE do funil para entradas sem trace.
//
// A entrada `streams` com trace explica "na hora da build". Sem trace (entrada
// legada, deploy antigo, kill-switch desligado na captura), o diagnóstico só
// pode explicar o que EXISTE localmente — com uma honestidade dura:
//
// 1. Estado de corte registrado aqui é ESTADO ATUAL, não causa do sumiço
//    histórico. Um item que a build cortou por `title-filter` e que hoje tem
//    `bad` aparece como `bad` no recompute — mas o rótulo `now` deixa
//    explícito que é a foto de HOJE, nunca "foi por isso que sumiu".
// 2. Matéria-prima é só o que está QUENTE no cache local (idx, raw por
//    indexer, inventário) via peeks quiet: nada de rede, nada de LRU-promote,
//    nada de contador. Sem material => `no-material`, nunca inventa.
// 3. O recompute NUNCA reescreve a entrada `streams` nem toca o debrid: é
//    leitura pura para o operador.
//
// A regra de ouro do repositório vale: ausência de evidência nunca autoriza
// afirmação — por isso `built:false` com `note` é um resultado LEGÍTIMO.
import config from '../config.js';
import { opts } from '../runtime.js';
import * as releaseIndex from './release-index.js';
import * as inventoryMemo from '../debrid/inventory-memo.js';
import jackett from '../providers/jackett.js';
import * as magnetdb from './magnetdb.js';
import * as autofetch from '../providers/autofetch.js';
import { accountScope } from './request-key.js';
import type { RawItem } from '../../types/domain.js';

/** Resultado da tentativa de recompute. Itens carregam só `now` (estado atual
 * via peeks quiet) — o recompute NÃO re-executa os cortes por item. */
export interface RecomputeOutcome {
  attempted: boolean;
  basis: string[]; // o que serviu de matéria-prima (idx/raw/inventory)
  built: boolean;
  builtAt: number | null;
  note: string | null; // no-material | no-names | ok
  items: Array<{
    id: string;
    label: string;
    br: boolean;
    dubbed?: boolean;
    quality?: string;
    now: { state: string };
  }>;
}

export const RECOMPUTE_MAX_ITEMS = 300; // mesmo teto do trace serializado

/** Junta matéria-prima local (idx quente + raw quente + inventário), com
 * dedupe por hash, e devolve o que dá para explicar. `names` vazios =>
 * chamador devolve no-names. */
export function collectLocalMaterial(
  imdbId: string,
  { season, episode, names, year }: { season: number | null; episode: number | null; names: string[]; year: number | null },
): { items: RawItem[]; basis: string[] } {
  const basis: string[] = [];
  const seen = new Set<string>();
  const out: RawItem[] = [];
  const push = (item: RawItem | null | undefined, origem: string) => {
    if (!item || !item.infoHash) return;
    const h = String(item.infoHash).toLowerCase();
    if (seen.has(h)) return;
    seen.add(h);
    if (!basis.includes(origem)) basis.push(origem);
    out.push(item);
  };

  // 1) Índice de releases (idx:v9): o que a busca já provou existir.
  const loc = { season: season ?? null, episode: episode ?? null };
  for (const rel of releaseIndex.lookupQuiet(imdbId, loc)) {
    push(
      { title: rel.title, infoHash: rel.hash, seeders: rel.seeders ?? 0, indexer: rel.indexer, size: rel.size ?? undefined },
      'idx',
    );
  }

  // 2) Cache bruto do Jackett (raw:v1) pelas queries da obra — SÓ o que a
  //    busca realmente consultaria (mesma moldura de chave do rawKeysFor).
  //    Usa a LISTA EFETIVA da instalação (opts().jackettIndexers), não a do
  //    operador: instalação com lista customizada consultou outra coisa, e o
  //    balde bruto precisa bater com o funil real.
  const type = season != null && episode != null ? 'series' : 'movie';
  const indexers = (opts()?.jackettIndexers?.length ? opts()!.jackettIndexers : config.jackett.indexers) as string[];
  const queries = names.filter(Boolean).map((n) => (year ? `${n} ${year}` : n));
  if (queries.length > 0 && indexers.length > 0) {
    for (const q of queries) {
      for (const item of jackett.peekRawFor(indexers, q, type)) push(item, 'raw');
    }
  }

  // 3) Inventário do memo (dinv) da CONTA EFETIVA desta instalação — leitura
  //    local de cache, sem rede e sem expor chave.
  const apiKey = opts()?.debridApiKey;
  const adapter = opts()?.debridService;
  if (apiKey && adapter) {
    const inv = inventoryMemo.peekQuiet(adapter, String(apiKey));
    if (Array.isArray(inv)) {
      for (const item of inv) push({ title: item.title, infoHash: item.infoHash, seeders: 0, indexer: 'account' }, 'inventory');
    }
  }

  return { items: out, basis };
}

/** Estado atual por item via leituras quiet (peek). NUNCA "causa": o rótulo
 * `now` deixa explícito que é a foto de HOJE, não o motivo na hora da build. */
function currentState(
  imdbId: string,
  item: RawItem,
  loc: { season: number | null; episode: number | null },
): { state: string } {
  const apiKey = String(opts()?.debridApiKey || '');
  const adapterId = opts()?.debridService || '';
  const hash = String(item.infoHash || '').toLowerCase();
  const reasons: string[] = [];
  if (adapterId && apiKey) {
    if (magnetdb.peekBad(adapterId, apiKey, hash)) reasons.push('bad');
    if (magnetdb.peekLie(adapterId, apiKey, hash)) reasons.push('lie');
    if (autofetch.isDeadQuiet(adapterId, accountScope(apiKey), hash)) reasons.push('dead');
    if (loc.season != null && loc.episode != null) {
      if (releaseIndex.isMissingQuiet(imdbId, { season: loc.season, episode: loc.episode }, hash)) reasons.push('idx-miss');
    }
  }
  return { state: reasons.length ? reasons.join('+') : 'tocável' };
}

/**
 * Roda o recompute sobre a matéria-prima local. Sem nomes => `no-names`; sem
 * material => `no-material`. Itens carregam `now` (estado atual, quiet).
 */
export function recomputeOffline(
  imdbId: string,
  location: { season: number | null; episode: number | null },
  names: string[],
  year: number | null,
): RecomputeOutcome {
  if (!names.length) {
    return { attempted: true, basis: [], built: false, builtAt: null, note: 'no-names', items: [] };
  }
  const { items, basis } = collectLocalMaterial(imdbId, { ...location, names, year });
  if (items.length === 0) {
    return { attempted: true, basis, built: false, builtAt: null, note: 'no-material', items: [] };
  }

  const itemsOut = items.slice(0, RECOMPUTE_MAX_ITEMS).map((item, i) => ({
    id: `r${i + 1}`,
    label: String(item.title || '').split('\n')[0],
    br: Boolean((item as any)._br || (item as any).isBr),
    ...((item as any)._dubbed !== undefined ? { dubbed: Boolean((item as any)._dubbed) } : {}),
    ...((item as any)._quality ? { quality: String((item as any)._quality) } : {}),
    now: currentState(imdbId, item, location),
  }));

  return {
    attempted: true,
    basis,
    built: true,
    builtAt: Date.now(),
    note: null,
    items: itemsOut,
  };
}
