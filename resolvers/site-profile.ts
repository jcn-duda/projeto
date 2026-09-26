// Bootstrap comum dos sete profiles de resolver (PLANO_MELHORIAS §5.8,
// passo 1 da extração do núcleo). Os seis perfis repetiam ~60-80 linhas
// idênticas de montagem — seletor de failover de domínio, conjuntos de
// sufixos do protetor, trio de allowlist (assertAllowedUrl/isDetailHost/
// isProtectorHost) e wrappers cosméticos — e cada cópia era um lugar a mais
// para os perfis divergirem sem ninguém perceber. A factory devolve TUDO POR
// CHAMADA:
//
// R-2 (sem estado de módulo): nada de singleton aqui. O harness de stress
// constrói instâncias novas com config explícita; um estado mutável em módulo
// de núcleo vazaria entre cenários. Toda a montagem vive no closure de cada
// createProfile().
//
// R-1 (crítico, MUT-06): a checagem de host NUNCA é reimplementada neste
// arquivo. O assertAllowedUrl devolvido delega ao assertAllowedUrl de
// protector.js — é exatamente a linha `if (!hasAllowedHost(...))` que o
// harness adversarial muta; reimplementar o if aqui tiraria a mutação do
// caminho executado e o desafio passaria em falso.
//
// Sem env no require-time: createProfile recebe `selfUrl`, `siteUrl` e a lista
// de protetores extras JÁ resolvidos pelo profile (que os obteve da factory
// explícita ou de env-config.js, em tempo de chamada). Assim o topo do módulo
// é import-safe e duas instâncias do mesmo perfil não compartilham estado.

import type { Server } from 'node:http';
import { USER_AGENT } from './runtime.js';
import {
  createSiteSelector as createSharedSiteSelector,
  isNetworkError as sharedIsNetworkError,
} from './site-selector.js';
import type { SiteSelectorOptions } from './site-selector.js';
import { mapLimit as sharedMapLimit } from './concurrency.js';
import { reply as sharedReply } from './http-server.js';
import { followProtectedUrl } from './transport.js';
import type { TransportOptions } from './types.js';
import { selectSearchPosts as selectSharedSearchPosts } from './search-posts.js';
import type { RequestedSeason } from './search-posts.js';
import type { MatchablePost } from './matching.js';
import { unwrapResolverUrl as unwrapSharedResolverUrl } from './nested-url.js';
import type { UnwrapResolverOptions, UnwrapResolverSeed, UnwrappedResolverUrl } from './nested-url.js';
import {
  BASE_PROTECTOR_SUFFIXES,
  hasAllowedHost,
  assertAllowedUrl as sharedAssertAllowedUrl,
  normalizeHostSuffixes,
} from './protector.js';
import { stripTags as stripTagsShared } from './text.js';
import type { DecodeEntities } from './text.js';
import type { ResolverPost, SiteSelector } from './types.js';

/** Logger de erro por item do `mapLimit` (bludv loga o post sem botões). */
export type MapLimitOnError<T = unknown> = (err: unknown, item: T) => void;

/** Opções do `mapLimit` do bootstrap. */
export interface MapLimitOptions<T = unknown> {
  limit?: number;
  onError?: MapLimitOnError<T> | null;
}

/**
 * Parsers que o perfil aporta; o assert/UA canônicos entram por dentro (R-1).
 * `assertAllowedUrl`/`userAgent` são aceitos por compatibilidade, mas
 * IGNORADOS: a factory sempre sobrescreve depois do spread — é o que o teste
 * de isolamento R-1 fixa ao tentar injetar um assert próprio.
 */
export type FetchFollowingOptions = Omit<TransportOptions, 'assertAllowedUrl' | 'userAgent'> & {
  /** Aceito por compatibilidade e IGNORADO (a factory sobrescreve). */
  assertAllowedUrl?: unknown;
  /** Aceito por compatibilidade e IGNORADO (a factory injeta o USER_AGENT). */
  userAgent?: unknown;
};

/** Opções aceitas pela factory do bootstrap (contrato real do site-profile). */
export interface ProfileOptions {
  /** Nome curto do perfil ('bludv', ...) — tag do seletor e nome no log de boot. */
  name: string;
  /** Porta do resolver standalone (8700-8706). */
  port: number;
  /** SELF_URL efetivo (override/env/default já resolvidos). */
  selfUrl: string;
  /** SITE_URL efetivo (override/SITE_URL/env do site/default). */
  siteUrl: string | undefined;
  /** Valor do csv <X>_URLS (candidatos extras do failover). */
  urlsCsv?: string | null;
  /** Mirrors históricos do site (candidatos ativos do seletor). */
  fallbackSuffixes: string[];
  /** Protetores extras já resolvidos (site + EXTRA_ALLOWED_PROTECTORS). */
  extraProtectorSuffixes?: string[];
  /** Hosts só de salto do protetor: entram no assert, nunca na descoberta. */
  assertOnlySuffixes?: string[];
  /** Inclui o host rejeitado na mensagem de blocked_host (nerdfilmes). */
  blockedHostDetail?: boolean;
  /** Exclusões extras do isNetworkError (bludv: '|flare_'). */
  networkErrorExtra?: string;
  /** Concorrência padrão do mapLimit. */
  concurrency?: number;
  /** Logger de erro por item do mapLimit (bludv). */
  mapOnError?: MapLimitOnError | null;
  /** Opções do desempacotamento de URL aninhada (bludv: /dl + audio/quality). */
  unwrapOptions?: UnwrapResolverOptions;
  /** Rótulo da rota no log de boot ('/api' ou '/search'). */
  bootRoute?: string;
  /** Variante de decodificação de entidades do perfil (rica vs básica). */
  decodeEntities: DecodeEntities;
}

/** Superfície devolvida por `createProfile` aos seis perfis. */
export interface ProfileBootstrap {
  selfUrl: string;
  siteSelector: SiteSelector;
  CANDIDATE_HOSTS: string[];
  ALL_PROTECTOR_SUFFIXES: string[];
  ALLOWED_SUFFIXES: string[];
  assertAllowedUrl(value: string | null | undefined): URL;
  isDetailHost(hostname: string | null | undefined): boolean;
  isProtectorHost(hostname: string | null | undefined): boolean;
  isAssertOnlyHost(hostname: string | null | undefined): boolean;
  isNetworkError(err: unknown): boolean;
  createSiteSelector: (
    tag: string,
    envUrlsCsv: string | null | undefined,
    primaryUrl: string | null | undefined,
    fallbackHosts: string[],
    options?: SiteSelectorOptions,
  ) => SiteSelector;
  stripTags(value?: string): string;
  mapLimit<T, R>(items: T[], fn: (item: T) => Promise<R>, opts?: MapLimitOptions<T>): Promise<R[]>;
  makeSelectSearchPosts<T extends MatchablePost>(
    parsePosts: (html: string) => T[],
    maxPosts: number,
  ): (sourceHtml: string, query: string, requestedSeason?: RequestedSeason) => T[];
  fetchFollowingAllowed(opts: FetchFollowingOptions): (value: string, referer?: string | null) => Promise<string>;
  unwrapResolverUrl(value: string, seed?: UnwrapResolverSeed): UnwrappedResolverUrl;
  reply: typeof sharedReply;
  serveMain(start: () => Server): void;
}

function createProfile(options: ProfileOptions): ProfileBootstrap {
  const {
    name,
    port,
    selfUrl,
    siteUrl,
    urlsCsv,
    fallbackSuffixes,
    extraProtectorSuffixes = [],
    assertOnlySuffixes = [],
    blockedHostDetail = false,
    networkErrorExtra = '',
    concurrency = 3,
    mapOnError = null,
    unwrapOptions = {},
    bootRoute = '/api',
    decodeEntities,
  } = options;

  // Normaliza os sufixos recebidos (site + EXTRA_ALLOWED_PROTECTORS): o host
  // comparado por hasAllowedHost é minúsculo, então caixa mista aqui viraria
  // match silenciosamente perdido. Idempotente para quem já mandou canônico.
  const fallbackHosts = normalizeHostSuffixes(fallbackSuffixes);
  const extraProtectors = normalizeHostSuffixes(extraProtectorSuffixes);
  const assertOnly = normalizeHostSuffixes(assertOnlySuffixes);

  const siteSelector = createSharedSiteSelector(`[${name}]`, urlsCsv, siteUrl, fallbackHosts);
  // Hosts de TODOS os candidatos são confiáveis desde o boot (vêm de env ou da
  // lista de mirrors históricos): allowlist e isDetailHost já aceitam o domínio
  // que o failover escolher, sem restart.
  const CANDIDATE_HOSTS = siteSelector.hosts();

  const ALL_PROTECTOR_SUFFIXES = Array.from(
    new Set([
      ...BASE_PROTECTOR_SUFFIXES,
      // Lista já resolvida pelo profile (protetores do site + EXTRA_ALLOWED_PROTECTORS).
      ...extraProtectors,
    ]),
  );

  const ALLOWED_SUFFIXES = Array.from(
    new Set([
      ...CANDIDATE_HOSTS,
      ...ALL_PROTECTOR_SUFFIXES,
      ...assertOnly,
    ]),
  );

  // R-1: delega ao protector.js. Nada de checagem local.
  function assertAllowedUrl(value: string | null | undefined): URL {
    return sharedAssertAllowedUrl(value, ALLOWED_SUFFIXES, blockedHostDetail);
  }

  function isDetailHost(hostname: string | null | undefined): boolean {
    return hasAllowedHost(hostname, CANDIDATE_HOSTS);
  }

  function isProtectorHost(hostname: string | null | undefined): boolean {
    return hasAllowedHost(hostname, ALL_PROTECTOR_SUFFIXES);
  }

  // Hosts só de passagem (ex.: t.co/vacadb.org do vacatorrent): permitidos no
  // transporte e no salto explícito, mas nunca alvo de descoberta genérica.
  // Lista vazia devolve false sempre — mesma semântica de hasAllowedHost(h, []).
  function isAssertOnlyHost(hostname: string | null | undefined): boolean {
    return hasAllowedHost(hostname, assertOnly);
  }

  function isNetworkError(err: unknown): boolean {
    return sharedIsNetworkError(err, networkErrorExtra);
  }

  // Envoltória cosmética: todo perfil casa stripTags com a SUA variante de
  // decodeEntities (rica nos WordPress novos, básica nos históricos).
  const stripTags = (value = '') => stripTagsShared(value, decodeEntities);

  /**
   * Map com teto de concorrência do perfil. `opts.limit` sobrepõe a
   * concorrência padrão (nerdfilmes passa o limite junto na chamada) e
   * `opts.onError` o logger por item (bludv loga o post sem botões).
   */
  function mapLimit<T, R>(
    items: T[],
    fn: (item: T) => Promise<R>,
    opts: MapLimitOptions<T> = {},
  ): Promise<R[]> {
    return sharedMapLimit(items, opts.limit ?? concurrency, fn, opts.onError ?? mapOnError);
  }

  /** Fixa o parser do perfil e devolve o seletor de posts de busca padrão. */
  function makeSelectSearchPosts<T extends MatchablePost>(parsePosts: (html: string) => T[], maxPosts: number) {
    return (sourceHtml: string, query: string, requestedSeason?: RequestedSeason): T[] =>
      selectSharedSearchPosts(parsePosts, sourceHtml, query, requestedSeason, maxPosts);
  }

  /**
   * Recebe os parsers próprios do perfil (extractMagnet/nextProtectedUrl/etc.,
   * definidos depois no módulo dele) e devolve o `(value, referer)` que
   * percorre o protetor. O assertAllowedUrl injetado no laço é SEMPRE o da
   * factory (R-1) — o perfil só aporta a extração de conteúdo.
   */
  function fetchFollowingAllowed(opts: FetchFollowingOptions) {
    return (value: string, referer?: string | null): Promise<string> => followProtectedUrl(value, referer, {
      ...opts,
      // R-1: o assert canônico e o UA entram DEPOIS do spread. Nenhum opts de
      // perfil pode substituir a checagem de allowlist — com o spread por
      // último, um `assertAllowedUrl` passado no opts furava o MUT-06.
      assertAllowedUrl,
      userAgent: USER_AGENT,
    });
  }

  /** Desempacota /resolve aninhado do cardigann contra o SELF_URL do perfil. */
  function unwrapResolverUrl(value: string, seed: UnwrapResolverSeed = {}): UnwrappedResolverUrl {
    return unwrapSharedResolverUrl(value, selfUrl, seed, unwrapOptions);
  }

  /** Boot do processo standalone, chamado pelo shim após `isMain(import.meta.url)`. */
  function serveMain(start: () => Server): void {
    start().listen(port, '0.0.0.0', () => {
      console.log(`${name}-resolver :${port} — torznab em ${bootRoute}, fonte ${siteSelector.url()} (failover: ${CANDIDATE_HOSTS.join(', ')})`);
    });
  }

  return {
    selfUrl,
    siteSelector,
    CANDIDATE_HOSTS,
    ALL_PROTECTOR_SUFFIXES,
    ALLOWED_SUFFIXES,
    assertAllowedUrl,
    isDetailHost,
    isProtectorHost,
    isAssertOnlyHost,
    isNetworkError,
    // Alias preservado: os perfis exportam createSiteSelector há versões e os
    // testes exercitam a superfície do perfil, não a do núcleo.
    createSiteSelector: createSharedSiteSelector,
    stripTags,
    mapLimit,
    makeSelectSearchPosts,
    fetchFollowingAllowed,
    unwrapResolverUrl,
    reply: sharedReply,
    serveMain,
  };
}

export { createProfile };
