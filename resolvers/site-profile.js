'use strict';

// Bootstrap comum dos cinco profiles de resolver (PLANO_MELHORIAS §5.8,
// passo 1 da extração do núcleo). Os cinco perfis repetiam ~60-80 linhas
// idênticas de montagem — seletor de failover de domínio, conjuntos de
// sufixos do protetor, trio de allowlist (assertAllowedUrl/isDetailHost/
// isProtectorHost) e wrappers cosméticos — e cada cópia era um lugar a mais
// para os perfis divergirem sem ninguém perceber. A factory devolve TUDO POR
// CHAMADA:
//
// R-2 (sem estado de módulo): nada de singleton aqui. O harness de stress faz
// fresh-require do shim do perfil; um estado mutável em módulo de núcleo
// vazaria entre cenários. Toda a montagem vive no closure de cada
// createProfile().
//
// R-1 (crítico, MUT-06): a checagem de host NUNCA é reimplementada neste
// arquivo. O assertAllowedUrl devolvido delega ao assertAllowedUrl de
// protector.js — é exatamente a linha `if (!hasAllowedHost(...))` que o
// harness adversarial muta; reimplementar o if aqui tiraria a mutação do
// caminho executado e o desafio passaria em falso.
//
// Env no require-time: createProfile roda no require do perfil, então ler
// SELF_URL/SITE_URL aqui preserva o contrato do modo embutido
// (src/br-resolvers.ts ajusta o ambiente ANTES do require e restaura depois).
// Adiar a leitura para dentro de handler quebraria a injeção.

const { USER_AGENT, parseExtraProtectors } = require('./runtime');
const {
  createSiteSelector: createSharedSiteSelector,
  isNetworkError: sharedIsNetworkError,
} = require('./site-selector');
const { mapLimit: sharedMapLimit } = require('./concurrency');
const { reply: sharedReply } = require('./http-server');
const { followProtectedUrl } = require('./transport');
const { selectSearchPosts: selectSharedSearchPosts } = require('./search-posts');
const { unwrapResolverUrl: unwrapSharedResolverUrl } = require('./nested-url');
const {
  BASE_PROTECTOR_SUFFIXES,
  hasAllowedHost,
  assertAllowedUrl: sharedAssertAllowedUrl,
} = require('./protector');
const { stripTags: stripTagsShared } = require('./text');

/**
 * @param {object} options
 * @param {string} options.name               Nome curto do perfil ('bludv', ...) — tag do seletor e nome no log de boot.
 * @param {number} options.port               Porta do resolver standalone (8700-8704).
 * @param {string} options.selfUrlEnv         Fallback do SELF_URL quando a env falta (ex.: 'http://bludv-resolver:8700').
 * @param {string} options.siteUrl            Default do SITE_URL (o modo embutido injeta a env SITE_URL por cima).
 * @param {string} options.siteUrlEnv         Env específica do site (BLUDV_URL, VACATORRENT_URL, ...).
 * @param {string|null} options.urlsCsv       Valor do csv <X>_URLS (candidatos extras do failover).
 * @param {string[]} options.fallbackSuffixes Mirrors históricos do site (candidatos ativos do seletor).
 * @param {string[]} [options.extraProtectorSuffixes] Sufixos de protetor próprios do site (ex.: 'systemtech.space').
 * @param {string[]} [options.assertOnlySuffixes]     Hosts só de salto do protetor: entram no assert, nunca na descoberta.
 * @param {boolean} [options.blockedHostDetail]       Inclui o host rejeitado na mensagem de blocked_host (nerdfilmes).
 * @param {string}  [options.networkErrorExtra]       Exclusões extras do isNetworkError (bludv: '|flare_').
 * @param {number}  [options.concurrency]             Concorrência padrão do mapLimit.
 * @param {Function|null} [options.mapOnError]        Logger de erro por item do mapLimit (bludv).
 * @param {object}  [options.unwrapOptions]           Opções do desempacotamento de URL aninhada (bludv: /dl + audio/quality).
 * @param {string}  [options.bootRoute]               Rótulo da rota no log de boot ('/api' ou '/search').
 * @param {Function} options.decodeEntities           Variante de decodificação de entidades do perfil (rica vs básica).
 */
function createProfile(options) {
  const {
    name,
    port,
    selfUrlEnv,
    siteUrl,
    siteUrlEnv,
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

  const selfUrl = (process.env.SELF_URL || selfUrlEnv).replace(/\/$/, '');
  const resolvedSiteUrl = (process.env.SITE_URL || process.env[siteUrlEnv] || siteUrl).replace(/\/$/, '');

  const siteSelector = createSharedSiteSelector(`[${name}]`, urlsCsv, resolvedSiteUrl, fallbackSuffixes);
  // Hosts de TODOS os candidatos são confiáveis desde o boot (vêm de env ou da
  // lista de mirrors históricos): allowlist e isDetailHost já aceitam o domínio
  // que o failover escolher, sem restart.
  const CANDIDATE_HOSTS = siteSelector.hosts();

  const ALL_PROTECTOR_SUFFIXES = Array.from(
    new Set([
      ...BASE_PROTECTOR_SUFFIXES,
      // O csv EXTRA_ALLOWED_PROTECTORS é lido UMA vez, no require — igual ao
      // que cada perfil fazia inline antes da extração.
      ...parseExtraProtectors(process.env.EXTRA_ALLOWED_PROTECTORS),
      ...extraProtectorSuffixes,
    ]),
  );

  const ALLOWED_SUFFIXES = Array.from(
    new Set([
      ...CANDIDATE_HOSTS,
      ...ALL_PROTECTOR_SUFFIXES,
      ...assertOnlySuffixes,
    ]),
  );

  // R-1: delega ao protector.js. Nada de checagem local.
  function assertAllowedUrl(value) {
    return sharedAssertAllowedUrl(value, ALLOWED_SUFFIXES, blockedHostDetail);
  }

  function isDetailHost(hostname) {
    return hasAllowedHost(hostname, CANDIDATE_HOSTS);
  }

  function isProtectorHost(hostname) {
    return hasAllowedHost(hostname, ALL_PROTECTOR_SUFFIXES);
  }

  // Hosts só de passagem (ex.: t.co/vacadb.org do vacatorrent): permitidos no
  // transporte e no salto explícito, mas nunca alvo de descoberta genérica.
  // Lista vazia devolve false sempre — mesma semântica de hasAllowedHost(h, []).
  function isAssertOnlyHost(hostname) {
    return hasAllowedHost(hostname, assertOnlySuffixes);
  }

  function isNetworkError(err) {
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
  function mapLimit(items, fn, opts = {}) {
    return sharedMapLimit(items, opts.limit ?? concurrency, fn, opts.onError ?? mapOnError);
  }

  /** Fixa o parser do perfil e devolve o seletor de posts de busca padrão. */
  function makeSelectSearchPosts(parsePosts, maxPosts) {
    return (sourceHtml, query, requestedSeason) =>
      selectSharedSearchPosts(parsePosts, sourceHtml, query, requestedSeason, maxPosts);
  }

  /**
   * Recebe os parsers próprios do perfil (extractMagnet/nextProtectedUrl/etc.,
   * definidos depois no módulo dele) e devolve o `(value, referer)` que
   * percorre o protetor. O assertAllowedUrl injetado no laço é SEMPRE o da
   * factory (R-1) — o perfil só aporta a extração de conteúdo.
   */
  function fetchFollowingAllowed(opts) {
    return (value, referer) => followProtectedUrl(value, referer, {
      assertAllowedUrl,
      userAgent: USER_AGENT,
      ...opts,
    });
  }

  /** Desempacota /resolve aninhado do cardigann contra o SELF_URL do perfil. */
  function unwrapResolverUrl(value, seed = {}) {
    return unwrapSharedResolverUrl(value, selfUrl, seed, unwrapOptions);
  }

  /**
   * Boot do processo standalone. O `require.main === module` continua no
   * perfil: aqui o módulo corrente seria este arquivo, não o chamador.
   */
  function serveMain(start) {
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

module.exports = { createProfile };
