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
  /**
   * DUAL em tracker global cujo título começa com o pt-BR do TMDB (pt distinto
   * do original/en). Alimenta `_br`/`_dubbed` via toStremioStream — sem isto
   * Dual sem acento perde a vaga BR para globais com mais seeders.
   */
  ptTitleDual?: boolean;
  /** Evidência observada no play/tail; sobrepõe o palpite do título. */
  provenQuality?: string;
  provenAudio?: string;
  provenName?: string;
  /** Campos preservados pelo índice e pela conta como fonte de busca. */
  fromAccount?: boolean;
  /**
   * Origem BR marcada só por `brOriginMark` (inventário da conta, caso
   * Zombieland): dá vaga reservada (`_br`) e NUNCA `_dubbed` — origem não
   * prova áudio. Ver `providers/account.ts`.
   */
  brOriginOnly?: boolean;
  dubbed?: boolean;
  lied?: boolean;
  quality?: string;
  hash?: string;
  season?: number | null;
  episode?: number | null;
  /** Item de reserva do banco (Etapa 4): indexer falho; nunca realimenta idx/banco/Chupim. */
  fromFallback?: boolean;
  fallbackIndexer?: string;
  /** Foto salva (idx) na resposta instantânea: só EXIBE 📦/~N; não tem as exclusões do fallback. */
  fromSnapshot?: boolean;
  [key: string]: unknown;
}

/** Dica assinada que acompanha o play para escolher arquivo de pack. */
export interface WorkHint {
  names?: string[];
  year?: number | null;
  pack?: boolean;
}

/**
 * Coleção multiobra descoberta por evidência (TMDB `belongs_to_collection`),
 * sob `BR_MULTIWORK_PACKS`, nativa por padrão (`false` é o kill-switch). `root`
 * é a raiz normalizada (tokens
 * contíguos) que o título do pack precisa conter; `years` são os anos das
 * partes. Só existe no contexto quando a feature está ativa, há debrid ativo,
 * é filme e o ano é conhecido.
 */
export interface MultiWorkCollection {
  /** Nome da coleção no TMDB (pt-BR), só para log/query. */
  name: string;
  /** Raiz normalizada (tokens contíguos) para a checagem de contiguidade. */
  root: string;
  /** Anos das partes da coleção (TMDB). */
  years: number[];
}

export interface PlayHint {
  season?: number | null;
  episode?: number | null;
  work?: WorkHint | null;
  dubbed?: boolean;
}

/** Estado observado por hash durante o recheck do autofetch. */
export interface TorrentStatusEntry {
  state: 'ready' | 'downloading' | 'dead' | 'unknown';
  stalled?: boolean;
  id?: string | number;
  /**
   * Progresso MEDIDO da transferência (Fase 3 do Chupim 2.0). Presente só
   * quando o serviço publica os campos (hoje só o AllDebrid); ausente =
   * "sem sinal" e nenhuma parada é derivada dele. `bytes`/`total`/`speed` em
   * bytes e bytes/s; `total` <= 0, campo ausente ou regressão de bytes não é
   * sinal.
   */
  progress?: { bytes: number; total: number; speed: number; seeders: number };
  /**
   * COMO a transferência foi ligada ao hash. `hash`: o próprio serviço
   * publicou o hash (src/nome/campo direto) — é a via histórica e a única
   * que o ciclo destrutivo sempre enxergou. `id`: só casou pelo id que o
   * enqueue registrou no marker. A distinção existe porque a via `id`
   * expõe de uma vez transferências que a remoção automática NUNCA
   * alcançou; o `removeById` decide se ela pode agir sobre elas.
   */
  via?: 'hash' | 'id';
}

/** Entrada persistida da busca; arrays legados são tratados no leitor. */
export interface StreamCacheEntry {
  streams: Stream[];
  partial?: boolean;
  debridKnown?: boolean;
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
  /** Total exato do torrent (bytes); sobrevive ao sortAndLimit, sai no limitReservingBr. */
  _bytes?: number;
  /**
   * Post promete Dublado/Dual/Nacional (ou PT explícito no título). Lista sob
   * `dubbedOnly`; NÃO é prova de áudio — chip/preferDubbed/Chupim/adprot usam
   * só `_dubbed`. Removido em `limitReservingBr`.
   */
  _dubClaim?: boolean;
  /** Áudio PT só com fileEvidence / provenAudio / provenName positivo. */
  _dubbed?: boolean;
  _br?: boolean;
  _tracker?: string;
  _indexer?: string;
  _multiWork?: boolean;
  /**
   * Marca INTERNA da feature BR_MULTIWORK_PACKS (nativa por padrão): o pack foi admitido pela
   * evidência de coleção (TMDB) com raiz contígua, nomes e cobertura do ano.
   * Diferente de `_multiWork` (heurística de título, sempre presente), esta só
   * existe quando a feature está ligada e admite o item — por isso todas as
   * regras novas (nunca P2P inteiro, fora do autofetch/warmer) se apoiam nela,
   * e o comportamento fica intacto com a flag desligada.
   */
  _multiWorkAdmitted?: boolean;
  /** Total do download de um filme em coleção cujo 💾 foi trocado pelo tamanho
   * do filme (episode-size). Interno: o índice do autofetch grava o total. */
  _packBytes?: number;
  /** Evidência medida de post dublado com arquivos EN; nunca vai ao cliente. */
  _lied?: boolean;
  /**
   * Sobreviveu ao piso de seeders pelo waiver BR dublado (sortAndLimit). Marca
   * interna para o enqueue do autofetch NÃO baixar o que o piso dispensou —
   * cache não precisa de swarm, download sim. Morre no limitReservingBr.
   */
  _seedFloorWaived?: boolean;
  /** Reserva do banco (Etapa 4): marca a lista como parcial/fallback; removida no protocolo. */
  _fromFallback?: boolean;
  /** Foto salva exibida com 📦: o `relabel` do dedupe precisa preservar o selo; removida no protocolo. */
  _fromSnapshot?: boolean;
  /** Campo INTERNO: dn= do magnet para o notCam do stream-ranking; removido antes do protocolo. */
  _magnetDn?: string;
  /** Marca interna do item de aviso — some antes do Stremio receber. */
  notice?: true;
}

/** Stream ainda em seleção interna; pools e testes podem omitir a ação final. */
export interface StreamCandidate extends StreamBase {
  /** Identificador auxiliar usado nos testes de cotas/prioridade. */
  id?: string;
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
  /** Id do torrent no serviço (Real-Debrid); o pipeline só precisa do hash. */
  id?: string;
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
    // `fileHashes`: packs cujos arquivos o memo ainda não conhece. Adapter que
    // sabe listar arquivos na checagem grava em `file-sizes.ts`; os outros ignoram.
    // `fileWaitTimeoutMs`: só para adapter não abortável com leitura de arquivos
    // na checagem (AllDebrid) — orçamento DINÂMICO da resposta para limitar a
    // ESPERA da leitura, sem tocar nos timeouts próprios de rede do adapter
    // (o upload da AllDebrid não pode virar abortável por causa dele). Já chega
    // com a margem (DEBRID_PACK_FILES_WAIT_MARGIN_MS) deduzida pelo
    // nonAbortableCheck: a espera interna desiste ANTES do prazo da corrida
    // externa, senão leitura lenta de pack virava known:false e apagava o ⚡.
    opts?: { timeoutMs?: number; fileHashes?: string[]; fileWaitTimeoutMs?: number },
  ): Promise<Set<string> | { cached: Set<string>; complete?: boolean }>;
  resolveLink(
    apiKey: string,
    hash: string,
    episode?: PlayHint,
  ): Promise<string | null>;
  /** Ocupação da conta para o `/debrid-status.json`; ausente = não suportado. */
  accountStatus?(apiKey: string): Promise<AccountStatus>;
  /**
   * Interpreta a ocupação que REALMENTE barra escrita neste serviço. Ausente
   * preserva o gate legado por `status.magnets >= autoFetchPauseAt`.
   */
  occupancy?(status: AccountStatus): { used: number; max: number } | null;
  /** Itens prontos na conta; ausente = no-op (serviço sem inventário legível). */
  inventory?(apiKey: string): Promise<InventoryItem[]>;
  /**
   * Enfileira download; ausente = autofetch/viaDebrid não usa.
   *
   * Retorno: `false` recusa. Aceite é qualquer valor verdadeiro — os
   * chamadores testam truthiness, nunca `=== true`. Quem souber o id da
   * transferência no serviço devolve a STRING do id: é a única âncora para
   * reencontrá-la depois em serviço que não publica o hash de volta (o
   * Premiumize é o caso; ver `transferHash` em premiumize.ts).
   */
  enqueue?(
    apiKey: string,
    hash: string,
    episode?: unknown,
  ): Promise<boolean | string>;
  warmInventory?(apiKey: string): Promise<unknown>;
  sweepDead?(apiKey: string): Promise<unknown>;
  /** Remove magnets antigos sem áudio PT da conta; ausente = não suportado. */
  sweepUndubbed?(apiKey: string): Promise<unknown>;
  /**
   * Mapa hash(minúsculo) -> { state: 'ready'|'downloading'|'dead'|'unknown', id?: any }
   *
   * `ids` é hash -> id da transferência, como o enqueue o registrou. Serve a
   * serviço que não devolve o hash na listagem: sem ele a maior parte da
   * conta fica invisível ao recheck. Adapter que não precisa dele ignora.
   */
  torrentStatus?(
    apiKey: string,
    infoHashes: string[],
    ids?: Record<string, string | number>,
  ): Promise<Record<string, TorrentStatusEntry>>;
  /** Remove torrent pelo id no serviço; ausente = não suportado */
  removeTorrent?(apiKey: string, id: string | number): Promise<boolean>;
  /**
   * Lista normalizada dos magnets da conta (só a AllDebrid implementa hoje).
   * Ausente = o catálogo/limpador não lista este serviço; os guardas usam
   * `typeof adapter.x === 'function'`.
   */
  magnetList?(apiKey: string): Promise<import('../src/debrid/alldebrid').AllDebridMagnetRow[]>;
  /** Arquivos de UM magnet por id; ausente = catálogo não audita arquivos aqui. */
  magnetFiles?(apiKey: string, serviceId: string | number): Promise<import('../src/debrid/file-selector.js').DebridFile[]>;
  /** Remove magnet(s) por id com backoff; ausente = sem delete dedicado.
   *  `removedIds` (opcional, AllDebrid) lista os ids que SAÍRAM de verdade —
   *  é o que o anti-reenchimento (8.14) usa para marcar sem marcar falha. */
  deleteMagnets?(
    apiKey: string,
    ids: Array<string | number>,
  ): Promise<{ ok: number; falhas: Array<{ message?: string }>; removedIds?: Array<string | number> }>;
  /**
   * Remove fallbacks `any`/`seeds` POR HASH (Fase 6 do Chupim 2.0). Só o
   * AllDebrid implementa: lê o status autoritativo da conta, exige `id` e
   * `filename` reais, nunca remove nome com sinal BR e passa pelo gate global
   * de delete (`deleteMagnets`). Devolve o que saiu e o motivo de cada pulo.
   * Ausente = serviço não suporta; a evicção nem tenta.
   */
  evictFallbacks?(
    apiKey: string,
    hashes: string[],
    opts?: { waitFn?: (ms: number) => Promise<unknown>; delays?: number[] },
  ): Promise<{
    removed: Array<{ hash: string; filename: string }>;
    skipped: Array<{ hash: string; reason: string }>;
  }>;
  /**
   * Snapshot `knownBefore` AGUARDADO para limpezas de fundo (30s de teto).
   * `null` = inventário não chegou: fail-safe fecha, nada pode ser apagado.
   */
  preexistingHashes?(apiKey: string): Promise<Set<string> | null>;
  /** Teto de enqueues/hora que este serviço aceita para item não-cacheado */
  enqueueHourlyLimit?: number;
  /** Pode participar do autofetch sem cacheCheck, sustentado por inventário */
  autofetchSource?: boolean;
  /**
   * Sonda se o hash toca na hora (só RD hoje). Ausente = serviço com
   * cacheCheck real ou sem substituto. Nunca no caminho da resposta.
   */
  probeInstant?(
    apiKey: string,
    infoHash: string,
  ): Promise<{ instant: boolean; reason: string }>;
  /** `GET /torrents/activeCount` (RD); ausente = não consultável. */
  activeTorrentCount?(apiKey: string): Promise<{ nb: number; limit: number } | null>;
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
  /** Data ISO de lançamento do filme (Cinemeta `released`), quando carregada. */
  released?: string | null;
  /** Data ISO de estreia (Cinemeta `firstAired`; em série, a data do EPISÓDIO pedido). */
  firstAired?: string | null;
  /** Opt-in multiobra: quando presente, packs da franquia podem ser admitidos. */
  multiWork?: MultiWorkCollection | null;
}
