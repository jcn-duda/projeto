'use strict';

/**
 * Esqueleto de roteador HTTP comum aos cinco perfis (passo 5 do item 9,
 * PLANO_MELHORIAS §5.8).
 *
 * O `handleRequest` era copiado nos cinco perfis (~45-60 linhas cada): bloqueio
 * GET-only, /health, /search, /resolve com unwrap, /dl 302 e /api torznab.
 * Aqui ficam o DESPACHO por pathname e as ROTAS PADRÃO como fábricas pequenas.
 * Perfis com lógica própria no caminho (bludv: prefs audio=/quality= no
 * /resolve; nerd: cache de busca próprio em /api e /search) passam o handler
 * da rota direto no mapa de rotas — esta factory NÃO ganha `if` por perfil.
 *
 * Contratos preservados EXATAMENTE (fixados pelos testes de resolver):
 * status/mensagens `invalid_url` / `invalid_params` / `invalid_index` /
 * `unsupported_t` / `not_found`, 502 com `error.message`, 302 no /dl e a
 * página HTML vazia (200) quando a query vem vazia.
 *
 * Sem estado de módulo (R-2): tudo nasce por chamada e o que a rota usa entra
 * INJETADO (`reply`, `unwrapResolverUrl`, resolvers do perfil) — nenhum perfil
 * é conhecido aqui e nenhum export de perfil muda (R-9).
 */

/**
 * Despacho comum: monta o `handleRequest` do perfil a partir do mapa de rotas.
 * `routes` mapeia pathname -> handler(url, response). A construção do URL, o
 * bloqueio GET-only e o 404 de fallback são idênticos aos dos cinco perfis.
 */
function createResolverRouter({ reply, routes }) {
  return async function handleRequest(request, response) {
    const url = new URL(request.url, `http://${request.headers.host}`);
    if (request.method !== 'GET') return reply(response, 404, 'not_found');
    const handler = routes[url.pathname];
    if (!handler) return reply(response, 404, 'not_found');
    return handler(url, response);
  };
}

/** GET /health → 200 "ok". Sonda do entrypoint/healthcheck do container. */
function createHealthRoute({ reply }) {
  return function handleHealth(url, response) {
    return reply(response, 200, 'ok');
  };
}

/**
 * GET /search?q= → página HTML do card Cardigann. Query vazia (ausente ou só
 * espaço) devolve a página SEM linhas com 200 — é o que os cinco perfis fazem.
 * `search(q)` devolve os itens; `renderHtml(items)` formata. Erro da busca é
 * 502 com a mensagem original (o Jackett precisa da causa diagnosticável).
 */
function createSearchRoute({ reply, search, renderHtml }) {
  return async function handleSearch(url, response) {
    const q = url.searchParams.get('q');
    if (!q || !q.trim()) {
      return reply(response, 200, renderHtml([]), 'text/html; charset=utf-8');
    }
    try {
      const items = await search(q);
      return reply(response, 200, renderHtml(items), 'text/html; charset=utf-8');
    } catch (error) {
      return reply(response, 502, error.message);
    }
  };
}

/**
 * GET /resolve?url= (com i/h/n aninhados no unwrap) → magnet.
 *
 * Duas variantes vivas entre os perfis, preservadas por `validateIndex`:
 * - false (comandotorrents/vacatorrent): índice presente e inválido NÃO é erro
 *   de rota — cai no `pickButton` e volta `no_such_button` (502), como sempre.
 * - true (torrentdosfilmes/nerdfilmes): índice inválido é erro EXPLÍCITO
 *   (`invalid_index` → 502) antes de tocar os links do post.
 * O bludv não usa esta rota (prefs audio=/quality= com validação própria →
 * handler dedicado no perfil).
 */
function createResolveRoute({
  reply, unwrapResolverUrl, resolveBest, resolveButton,
  fields = { index: 'i', hash: 'h', count: 'n' },
  validateIndex = false,
}) {
  return async function handleResolve(url, response) {
    const value = url.searchParams.get('url');
    if (!value || value.length > 4096) return reply(response, 400, 'invalid_url');
    try {
      const unwrapped = unwrapResolverUrl(value, {
        index: url.searchParams.get(fields.index),
        hash: url.searchParams.get(fields.hash),
        count: url.searchParams.get(fields.count),
      });
      const index = unwrapped.index == null ? null : Number(unwrapped.index);
      if (validateIndex && index != null && (!Number.isInteger(index) || index < 0)) {
        throw new Error('invalid_index');
      }
      return reply(
        response,
        200,
        index == null
          ? await resolveBest(unwrapped.url)
          : await resolveButton(unwrapped.url, index, unwrapped.hash, unwrapped.count),
      );
    } catch (error) {
      return reply(response, 502, error.message);
    }
  };
}

/**
 * GET /dl?url=&i= → 302 para o magnet do botão. Validação dura
 * (`invalid_params` → 400) porque esta rota é consumida por redirect direto
 * do cardigann, sem corpo para explicar erro. Idêntica nos três perfis que a
 * expõem (tdf, nerd, bludv).
 */
function createDlRoute({ reply, resolveButton }) {
  return async function handleDl(url, response) {
    const postUrl = url.searchParams.get('url');
    const index = Number(url.searchParams.get('i'));
    if (!postUrl || postUrl.length > 4096 || !Number.isInteger(index) || index < 0) {
      return reply(response, 400, 'invalid_params');
    }
    try {
      const magnet = await resolveButton(postUrl, index, url.searchParams.get('h'), url.searchParams.get('n'));
      response.writeHead(302, { Location: magnet, 'Cache-Control': 'no-store' });
      return response.end();
    } catch (error) {
      return reply(response, 502, error.message);
    }
  };
}

/**
 * GET /api?t= (torznab) → XML RSS. `t=caps` devolve o documento de caps;
 * `t` fora de search/movie/tvsearch é `unsupported_t` (400). A query vazia
 * devolve feed vazio com 200 — mas a CATEGORIA do feed vazio é decisão do
 * perfil (`emptyXml`): tdf espelha a categoria pedida, bludv sempre 2000.
 * `search(q)` devolve itens; `renderXml(items, category)` formata.
 */
function createApiRoute({ reply, capsXml, emptyXml, renderXml, search }) {
  return async function handleApi(url, response) {
    const type = url.searchParams.get('t') || 'caps';
    if (type === 'caps') return reply(response, 200, capsXml(), 'application/xml; charset=utf-8');
    if (!['search', 'movie', 'tvsearch'].includes(type)) return reply(response, 400, 'unsupported_t');
    const q = url.searchParams.get('q');
    const category = type === 'tvsearch' ? 5000 : 2000;
    if (!q || !q.trim()) {
      return reply(response, 200, emptyXml(category, type), 'application/xml; charset=utf-8');
    }
    try {
      const items = await search(q);
      return reply(response, 200, renderXml(items, category), 'application/xml; charset=utf-8');
    } catch (error) {
      return reply(response, 502, error.message);
    }
  };
}

module.exports = {
  createResolverRouter,
  createHealthRoute,
  createSearchRoute,
  createResolveRoute,
  createDlRoute,
  createApiRoute,
};
