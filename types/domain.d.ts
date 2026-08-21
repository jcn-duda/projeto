/**
 * Tipos de domínio do addon, ancorados em bugs reais desta sessão. Arquivo só
 * de tipos: o Node nunca o carrega, e os `.js` o referenciam por
 * `import('../types/domain')` dentro de um `@type` JSDoc.
 *
 * Cada typedef existe porque um bug só aparece quando o objeto é montado ou
 * consumido errado; o comentário explica POR QUE o campo é obrigatório, na
 * mesma convenção do resto do repositório.
 */

/**
 * Item cru vindo de Jackett/Prowlarr/resolver, antes de virar `Stream`. Faz
 * parte das assinaturas de `toStremioStream` e do filtro de inventário.
 */
export interface RawItem {
  title?: string;
  Title?: string;
  infoHash?: string;
  magnet?: string;
  MagnetUri?: string;
  Guid?: string;
  seeders?: number;
  Seeders?: number;
  size?: number;
  Size?: number;
  tracker?: string;
  Tracker?: string;
  indexer?: string;
  Indexer?: string;
  isBr?: boolean;
  [key: string]: unknown;
}

/**
 * Stream do addon, do formato interno até o que chega ao Stremio.
 *
 * A união força a AÇÃO: todo item precisa de ao menos um de
 *
 * - `url`        — link pronto (debrid resolvido);
 * - `infoHash`   — torrent puro / P2P (o play monta o magnet);
 * - `externalUrl`— aviso de lista vazia acionável (aponta pra /configure);
 * - `notice`     — aviso INTERNO, ainda sem origin; o `applyNoticeOrigin` o
 *                  converte em `externalUrl` antes da resposta (ou o descarta
 *                  se não há origin).
 *
 * Sem nenhum dos quatro nenhum cliente Stremio renderiza a linha: foi o bug do
 * aviso saindo só com `name` e sumindo da tela, deixando "Nenhum stream
 * disponível" quando a busca já tinha resultado. `{ name }` puro precisa ser
 * rejeitado aqui, na origem.
 */
export interface StreamBase {
  /** Coluna estreita: marca + qualidade + seeders. */
  name?: string;
  /** Release completa, coluna larga de detalhes. */
  title?: string;
  /** Link direto / debrid pronto para tocar. */
  url?: string;
  /** btih 40 hex, para play P2P ou `/resolve`. */
  infoHash?: string;
  /** Aviso acionável (configuração) quando não há resultado. */
  externalUrl?: string;
  sources?: string[];
  behaviorHints?: unknown;
  // Campos internos (prefixo `_`). Todos são removidos em `limitReservingBr`
  // antes de entregar ao Stremio.
  _seeders?: number;
  _quality?: string;
  _size?: number;
  _dubbed?: boolean;
  _br?: boolean;
  _tracker?: string;
  _indexer?: string;
  _multiWork?: boolean;
  /** Marca interna do item de aviso — some antes do Stremio receber. */
  notice?: true;
}

export type Stream =
  | (StreamBase & { url: string; infoHash?: undefined; externalUrl?: string })
  | (StreamBase & { infoHash: string; externalUrl?: string })
  | (StreamBase & { externalUrl: string })
  | (StreamBase & { notice: true });

/**
 * Temporada/episódio lidos do título de uma release.
 *
 * `seasonPack` nasceu de um bug de semântica: "2ª Temporada Completa" é pack
 * da TEMPORADA nomeada, não da série inteira. Tratar o singular como cobertura
 * total fazia S01/S02 entrar no resultado do S04E06. Quem consome o retorno
 * precisa saber distinguir `complete` (série inteira) de `seasonPack` (uma
 * temporada); acrescentar um campo aqui quebrou oito `deepEqual` de uma vez,
 * e um retorno tipado teria apontado isso na hora.
 */
export interface ParsedSeasonEpisode {
  seasons: number[];
  episodes: number[];
  /** "Todas as Temporadas"/"Série Completa": cobre a série inteira. */
  complete: boolean;
  /** "Nª Temporada Completa": pack de UMA temporada nomeada. */
  seasonPack: boolean;
}

/**
 * Ocupação da conta para o `/debrid-status.json`. Todo campo é opcional porque
 * cada serviço mede o que consegue: AllDebrid conta magnets por estado (não tem
 * teto consultável), Premiumize só publica o fair-use (`limit_used` em [0,1]) e
 * TorBox conta o mylist. Quem consome já decide pelo que existe —
 * `Number.isFinite(status.limitUsed)` escolhe entre o aviso por percentual e o
 * aviso por contagem.
 */
export interface AccountStatus {
  /** Total de magnets/torrents na conta (AllDebrid, TorBox). */
  magnets?: number;
  ready?: number;
  active?: number;
  error?: number;
  /** Fair-use do Premiumize em [0,1]; `null` quando a API não informou. */
  limitUsed?: number | null;
  premiumUntil?: number | null;
  oldestAt?: number | string | null;
}

/** Item já PRONTO na conta do debrid, usado como fonte de busca. */
export interface InventoryItem {
  title: string;
  infoHash: string;
  size: number;
}

/**
 * Contrato uniforme de adaptador de debrid. `src/debrid/index.js` só conhece
 * os serviços por esta forma; um adapter sem método obrigatório hoje só é
 * pego pelo `typeof adapter.accountStatus !== 'function'` na hora de usar.
 * Tipar o contrato faz o erro aparecer no registro, não no diagnóstico.
 */
export interface DebridAdapter {
  id: string;
  label: string;
  /** Sigla curta para o prefixo da linha (`[AD⚡]`). */
  short: string;
  /**
   * Distinção que mais importa: `true` = o serviço conta se um hash toca na
   * hora (AllDebrid via `/magnet/upload`, Premiumize, TorBox); `false` = não
   * dá pra saber de antemão (Real-Debrid, Debrid-Link).
   */
  cacheCheck: boolean;
  /** Consulta de cache NÃO abortável (AllDebrid): o upload não pode ser
   * cancelado depois de enviado. */
  abortSafeCacheCheck?: boolean;
  keyUrl: string;
  checkCached(
    apiKey: string,
    hashes: string[],
    opts?: { timeoutMs?: number },
  ): Promise<Set<string> | { cached: Set<string>; complete?: boolean }>;
  resolveLink(
    apiKey: string,
    hash: string,
    episode?: { season?: number | null; episode?: number | null; work?: unknown },
  ): Promise<string | null>;
  /** Ocupação da conta para o `/debrid-status.json`; ausente = não suportado. */
  accountStatus?(apiKey: string): Promise<AccountStatus>;
  /** Itens prontos na conta; ausente = no-op (serviço sem inventário legível). */
  inventory?(apiKey: string): Promise<InventoryItem[]>;
  /** Enfileira download; ausente = autofetch/viaDebrid não usa. */
  enqueue?(
    apiKey: string,
    hash: string,
    episode?: unknown,
  ): Promise<boolean>;
  warmInventory?(apiKey: string): Promise<unknown>;
  sweepDead?(apiKey: string): Promise<unknown>;
  /** Mapa hash(minúsculo) -> { state: 'ready'|'downloading'|'dead'|'unknown', id?: any } */
  torrentStatus?(
    apiKey: string,
    infoHashes: string[],
  ): Promise<Record<string, { state: 'ready' | 'downloading' | 'dead' | 'unknown'; stalled?: boolean; id?: any }>>;
  /** Remove torrent pelo id no serviço; ausente = não suportado */
  removeTorrent?(apiKey: string, id: any): Promise<boolean>;
  /** Teto de enqueues/hora que este serviço aceita para item não-cacheado */
  enqueueHourlyLimit?: number;
  /** Pode participar do autofetch sem cacheCheck, sustentado por inventário */
  autofetchSource?: boolean;
}

/**
 * Contexto de matching que atravessa o pipeline de filtro
 * (`filterRelevantRaw`, `matchesBrTitle`, `matchesEpisode`…). Nasceu porque
 * um contexto malformado — campo opcional faltando ou ano sujo — derruba o
 * filtro em silêncio e deixa lixo de indexer tomar as vagas BR.
 */
export interface MatchContext {
  /** Todos os nomes conhecidos da obra (título original + pt + alias). */
  names: string[];
  /** Ano de catálogo como veio do metadata (pode trazer sufixo, ex. "2024–"). */
  year: number | string | null;
  isSeries: boolean;
  season: number | null;
  episode: number | null;
}
