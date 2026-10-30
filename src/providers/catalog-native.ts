// Catálogo de indexers lido do GATEWAY (admin 8711, `GET /indexers/catalog`).
//
// Desde a F4.2 o gateway (Rust) consulta o Jackett, guarda o memo/TTL e
// publica `{ok, cards, source}` na admin: cards camelCase `id/label/language/
// isBr` (+ `virtual` só no Mico) e `source: live|fallback` da coleta. Desde a
// F4.6 esta ponte é a ÚNICA fonte do catálogo (/defaults.json e os blocos
// general/indexers do painel) — o coletor TS (`jackett-catalog.ts`) saiu; sem
// a ponte, o consumidor segue com a lista vazia.
//
// Os cards voltam JÁ decorados com o status de saúde (`indexerStatus.decorate`)
// e com o `source` do gateway anexado — exatamente o shape do `load()` do TS
// (`CatalogList`), para o consumidor não distinguir a origem e o tri-state do
// painel (`jackettServiceFlag`) continuar valendo sem ajuste.
//
// Fail-open (mesma régua de `indexer-status-native.ts`): falha de rede, HTTP
// não-2xx, corpo estranho ou timeout devolve null sem lançar — a rota nunca
// morre por causa da ponte.
import config from '../config.js';
import * as log from '../utils/logger.js';
import * as metrics from '../utils/metrics.js';
import * as indexerStatus from './indexer-status.js';

type CatalogSource = 'live' | 'fallback';

interface NativeCatalogCard {
  id: string;
  label: string;
  language: string;
  isBr: boolean;
  /** Card virtual (Mico): fora da prova de vida do catálogo. */
  virtual?: boolean;
}

/** Mesmo tipo do antigo `CatalogList` do TS: array + `source`. */
export type NativeCatalogList = ReturnType<typeof indexerStatus.decorate> & { source: CatalogSource };

function baseUrl(): string {
  return String(config.streamStore.url || '').replace(/\/+$/, '');
}

function token(): string {
  return config.streamStore.token || config.jackett.testToken || '';
}

/** Card do gateway com campos garantidos; sem id, o card não entra. */
function safeCard(raw: unknown): NativeCatalogCard | null {
  if (!raw || typeof raw !== 'object') return null;
  const card = raw as Record<string, unknown>;
  const id = String(card.id ?? '').trim().toLowerCase();
  if (!id) return null;
  return {
    id,
    label: String(card.label ?? id),
    language: String(card.language ?? ''),
    isBr: card.isBr === true,
    ...(card.virtual === true ? { virtual: true as const } : {}),
  };
}

/** Catálogo do gateway; `null` = ponte fora (o chamador segue com a lista vazia). */
export async function loadNativeCatalog(): Promise<NativeCatalogList | null> {
  try {
    const res = await fetch(`${baseUrl()}/indexers/catalog`, {
      headers: { 'x-indexer-test-token': token(), accept: 'application/json' },
      signal: AbortSignal.timeout(Math.max(1, Number(config.streamStore.timeoutMs) || 2000)),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = (await res.json()) as { cards?: unknown; source?: unknown };
    const source: CatalogSource = json?.source === 'live' ? 'live' : 'fallback';
    const cards = (Array.isArray(json?.cards) ? json.cards : [])
      .map(safeCard)
      .filter((card): card is NativeCatalogCard => card !== null);
    return Object.assign(indexerStatus.decorate(cards), { source });
  } catch (err) {
    metrics.count('indexer.catalog.bridge_errors');
    log.debug(`[jackett] catálogo nativo indisponível: ${log.errorMessage(err)}`);
    return null;
  }
}
