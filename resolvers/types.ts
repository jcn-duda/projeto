// Contratos REAIS e compartilhados da ilha dos resolvers (conversão
// TypeScript). Eles substituíram o antigo `types/resolver-shim.d.ts` (já
// removido), que descrevia formas inventadas (ex.: um cache Map-fachada e um
// `noteFailure(): void` que nunca existiram) e obrigava cast em quem consumia.
//
// Diferença de `types/domain.d.ts`: aqui mora só o que os resolvedores
// PUBLICAM e trocam entre si — nenhum tipo do addon (Stream/DebridAdapter)
// entra nesta ilha.

/** Post raspado de uma página de busca WordPress. Campos extras do site são aceitos. */
export interface ResolverPost {
  url: string;
  title: string;
  poster?: string | null;
  original?: string | null;
  date?: string | null;
  /** Ano do catálogo do site (vaca) ou extraído do título (rede); opcional. */
  year?: number | null;
}

/** Marcador de áudio. O valor cru vem da listagem; a união só documenta os dois vivos. */
export type ResolverAudio = 'dublado' | 'legendado' | 'dual' | (string & {});

/** Botão de download extraído de um post. */
export interface ResolverLink {
  url: string;
  quality: number | null;
  size: string | null;
  /** VacaTorrent parte de `null` quando o bloco não traz marcador de áudio. */
  audio: ResolverAudio | null;
  source: string | null;
  episode: number | null;
}

/**
 * Botão já parselado com os campos que o perfil acrescenta no `extrasOf` do
 * `createLinkCollector` (rede/vaca: `season` e `realTitle`), consumidos pelos
 * hooks do `createReleaseTitle`. São opcionais e não vazam para o stream.
 */
export interface ParsedResolverLink extends ResolverLink {
  season?: number | null;
  realTitle?: string | null;
}

/** Entrada parcial do botão antes da classificação (parsers e factories). */
export type ResolverLinkInput = Partial<ParsedResolverLink>;

/** Entrada guardada no `values` de `createCache` (Map real, não uma fachada). */
export interface ResolverCacheEntry<T = unknown> {
  value: T;
  expiresAt: number;
}

/**
 * Cache real dos perfis: os perfis desestruturam `values` de `createCache` e o
 * expõem como `postCache`/`searchCache`/`magnetCache`. Portanto é o próprio
 * `Map<string, ResolverCacheEntry>`, com o `get` podendo devolver `undefined`.
 */
export type ResolverCache<T = unknown> = Map<string, ResolverCacheEntry<T>>;

/** Seletor de domínio com failover (site-selector.js). */
export interface SiteSelector {
  url(): string;
  hosts(): string[];
  /**
   * Registra uma falha de rede. Devolve o domínio CORRENTE após a tentativa —
   * o contrato antigo dizia `void` e quem consumisse o retorno perdia o valor.
   */
  noteFailure(): Promise<string>;
  noteSuccess(): void;
  onDomainChange(listener: (url: string) => void): void;
}

/** Configuração efetiva montada por `buildProfileConfig` (env + overrides). */
export interface ResolverConfig {
  port: number | undefined;
  selfUrl: string | undefined;
  siteUrl: string | undefined;
  urlsCsv: string | undefined;
  timeoutMs: number | undefined;
  maxHops: number | undefined;
  maxPosts: number | undefined;
  postCacheMs: number | undefined;
  searchCacheMs: number | undefined;
  magnetCacheMs: number | undefined;
  maxResolveAttempts: number | undefined;
  extraProtectors: string[];
  flare: {
    solverUrl: string | undefined;
    timeoutMs: number | undefined;
    sessionTtlMs: number | undefined;
  };
}

/** Defaults estáticos declarados por cada profile. */
export interface ProfileDefaults {
  port?: number;
  selfUrl?: string;
  siteUrl?: string;
  urlsCsv?: string;
  timeoutMs?: number;
  maxHops?: number;
  maxPosts?: number;
  postCacheMs?: number;
  searchCacheMs?: number;
  magnetCacheMs?: number;
  maxResolveAttempts?: number;
  flare?: { solverUrl?: string; timeoutMs?: number; sessionTtlMs?: number };
}

/** Metadados estáticos do profile consumidos por env-config.js. */
export interface ResolverMeta {
  name: string;
  siteEnv: string;
  urlsEnv?: string;
  maxPostsEnv?: string;
  defaults: ProfileDefaults;
}

/** Sementes de cookie aceitas no formato-objeto de `cookieJar`. */
export interface CookieJarSeed {
  seed?: Record<string, Record<string, string>>;
}

/** Opções injetadas no laço único do protetor (`followProtectedUrl`). */
export interface TransportOptions {
  assertAllowedUrl(value: string | null | undefined): URL;
  decodeEntities(value?: string | null): string;
  extractMagnet(html: string | null | undefined): string | null;
  nextProtectedUrl(html: string | null | undefined, baseUrl?: string): string | null;
  extractMetaRefresh(html: string | null | undefined): string | null;
  maxHops: number;
  timeoutMs: number;
  userAgent: string;
  cookieJar?: boolean | CookieJarSeed;
}

/**
 * Resultado de um salto resolvido pelo `resolveHref` da máquina de âncoras.
 * União discriminada: ou traz a URL resolvida, ou pede para pular o botão
 * (`advance` diz se o cursor da seção avança mesmo descartando o botão).
 */
export type ResolvedHref =
  | { url: string; skip?: false; advance?: boolean }
  | { skip: true; advance?: boolean };
