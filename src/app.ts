import { fileURLToPath } from 'node:url';
import path from 'node:path';
import express from 'express';
import sdk from 'stremio-addon-sdk';
import config from './config.js';
import { findStreams, applyNoticeOrigin, onlyNotice, autofetchStatus } from './providers/index.js';
import debrid from './debrid/index.js';
import { isWorkPickError, isEpisodePickError } from './debrid/common.js';
import * as runtime from './runtime.js';
import { verifyResolve } from './utils/sign.js';
import * as jackettCatalog from './providers/jackett-catalog.js';
import jackett from './providers/jackett.js';
import { authorized, createDiagnosticGate } from './utils/diagnostic-guard.js';
import * as secretBox from './utils/secret-box.js';
import * as metrics from './utils/metrics.js';
import * as cache from './utils/cache.js';
import * as log from './utils/logger.js';
import * as autofetch from './providers/autofetch.js';
import { accountScope } from './utils/request-key.js';
import * as magnetdb from './utils/magnetdb.js';
import { RESOLVERS } from './br-resolvers.js';

const { addonBuilder, getRouter } = sdk;

const prefetchInFlight = new Set<string>();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Estado da lista vinda de `findStreams`, na forma que o cache persiste e que o
 * handler de stream relê. Tipar o pacote inteiro — e não só `streams`, que tem
 * default no destructuring — evita que o TS infira `{ streams?: never[] }` e
 * condene o acesso aos três campos de revalidação.
 */
interface StreamResultMeta {
  /** Streams já filtrados e assinados. */
  streams?: any[];
  /** Coleta cortada pelo prazo da resposta. */
  partial?: boolean;
  /** Refresh de cache pendente no fundo. */
  needsDebridRefresh?: boolean;
  /** Checagem de cache concluída com confiança. */
  debridKnown?: boolean;
}

/**
 * Quando a consulta da AllDebrid não cabe no prazo, o primeiro lote pode sair
 * como `[AD download]`; o cliente precisa perguntar de novo para pegar o cache
 * do servidor já reconstruído com ⚡. Cachear esse lote por 15 minutos tornava
 * a atualização tardia invisível mesmo quando o hash estava pronto.
 */
function streamsNeedRevalidation({ streams = [], partial, needsDebridRefresh, debridKnown }: StreamResultMeta = {}) {
  return !streams.length || partial || needsDebridRefresh || debridKnown === false;
}

// Host do cabeçalho é input do cliente; aqui ele só volta para o próprio cliente
// que o mandou (nunca é chamado para outro destino), mas não há motivo para
// propagar lixo no externalUrl — barra hostname/porta válidos e IPv6 entre
// colchetes. Qualquer outra forma (path, scheme, espaço) vira null.
const ORIGIN_HOSTNAME_RE = /^[A-Za-z0-9.-]+(:\d{1,5})?$/;
const ORIGIN_HOST_V6_RE = /^\[[0-9A-Fa-f:.]+\](:\d{1,5})?$/;

/**
 * Origin que o cliente alcança: `PUBLIC_URL` tem precedência (é o endereço
 * público quando existe); senão `protocol://host` do cabeçalho. Sem host válido
 * devolve null — e o aviso de lista vazia, sem origin, prefere não sair.
 */
function originOf(req: { get(name: string): string | undefined; protocol: string }) {
  if (config.debrid.publicUrl) return config.debrid.publicUrl;
  const host = req.get('host');
  if (!host) return null;
  if (ORIGIN_HOSTNAME_RE.test(host) || ORIGIN_HOST_V6_RE.test(host)) {
    return `${req.protocol}://${host}`;
  }
  return null;
}

/**
 * Resultado de `enter()` no gate de diagnóstico (seal e testes de indexer): ou
 * a vaga é negada (`status` + `error`, resposta curta de 429) ou é tomada
 * (`release`, que o `finally` devolve). União discriminada por `ok` — sem ela
 * o TS deixa `status` como `number | undefined` e `release` como possivelmente
 * ausente, porque o tipo inferido do gate é um union de dois shapes soltos.
 */
type GateAdmission = { ok: true; release: () => void } | { ok: false; status: number; error: string };

/**
 * Monta o app Express completo do addon sem nenhum efeito colateral (sem
 * listen, sem warmup, sem carregar resolvers). Existe para os testes poderem
 * exercitar as rotas REAIS — antes o harness e2e mantinha uma cópia de ~160
 * linhas daqui e divergia em silêncio.
 *
 * Os gates ficam DENTRO da fábrica: cada app ganha o seu estado de rate
 * limit, então testes paralelos não disputam as mesmas vagas.
 */
function createApp() {
  const diagnosticGate = createDiagnosticGate();

  // /seal-config é público como o resto de /configure. Selar é barato (o scrypt
  // fica em cache e sobra o AES), mas "barato" e "de graça" não são a mesma
  // coisa: sem teto o endpoint vira um jeito de queimar CPU da instância.
  //
  // Global, e não por IP, pelo mesmo motivo do /test-indexer.json: atrás do Caddy
  // o req.ip é o proxy, então limitar por cliente limitaria todo mundo junto.
  //
  // Quem protege de fato aqui é a JANELA: o handler é síncrono, então ele entra e
  // libera a vaga antes do próximo pedido ser despachado, e o teto de
  // concorrência nunca chega a fechar. Ele fica como rede para o dia em que a
  // selagem virar assíncrona. O limite por minuto é folgado de propósito — a
  // página pede o selo enquanto se digita a chave (com debounce de 250ms), e um
  // 429 no meio disso seria um bug de UX, não proteção.
  const sealGate = createDiagnosticGate({
    limit: 600,
    maxConcurrent: 4,
    rateMessage: 'muitos pedidos de selo; tente de novo em instantes',
    busyMessage: 'selo ocupado; tente de novo em instantes',
  });

  const manifest = {
    id: config.addonId,
    version: config.version,
    name: config.addonName,
    description:
      'Torrents self-hosted com prioridade para conteúdo brasileiro dublado. ' +
      'Busca em paralelo via Jackett (BLUDV, Comando, NerdFilmes, TorrentDosFilmes, ' +
      'RedeTorrent + indexers globais) e entrega play instantâneo por debrid.',
    // Servido pelo próprio addon quando há PUBLIC_URL; sem ela o cliente não
    // alcançaria um caminho relativo, então cai no logo genérico do Stremio.
    // PNG, não o SVG que a /configure usa: o Stremio pede 256x256 png e o
    // cliente cai no ícone de engrenagem quando recebe SVG.
    logo: config.debrid.publicUrl
      ? `${config.debrid.publicUrl}/logo.png`
      : 'https://www.stremio.com/website/stremio-logo-small.png',
    resources: ['stream'],
    types: ['movie', 'series'],
    idPrefixes: ['tt'],
    catalogs: [],
    behaviorHints: {
      adult: false,
      // Liga o botão de engrenagem do Stremio, que aponta pra /configure.
      configurable: true,
      configurationRequired: false,
    },
  };

  const builder = new addonBuilder(manifest);

  builder.defineStreamHandler(async (args) => {
    try {
      const result = await findStreams({ type: args.type, id: args.id });
      // Prefetch do próximo episódio em background para séries
      if (args.type === 'series' && typeof args.id === 'string') {
        const parts = args.id.split(':');
        if (parts.length >= 3) {
          const imdbId = parts[0];
          const s = parseInt(parts[1], 10);
          const e = parseInt(parts[2], 10);
          if (Number.isFinite(s) && Number.isFinite(e)) {
            const nextId = `${imdbId}:${s}:${e + 1}`;
            const adapter = debrid.current();
            const { autoFetchBr, debridApiKey } = runtime.opts();
            if (
              config.debrid.prefetchNextEp &&
              autoFetchBr &&
              adapter &&
              (adapter.cacheCheck || adapter.autofetchSource)
            ) {
              const account = accountScope(debridApiKey);
              const pfKey = autofetch.prefetchKey(account, imdbId, s, e + 1);
              if (!cache.get(pfKey) && !prefetchInFlight.has(nextId)) {
                cache.set(pfKey, 1, config.debrid.prefetchTtl);
                prefetchInFlight.add(nextId);
                const capturedCtx = runtime.capture();
                Promise.resolve(
                  runtime.run(capturedCtx, () =>
                    findStreams({ type: 'series', id: nextId, background: true }),
                  ),
                )
                  .catch((err: any) => log.warn('[prefetch] falha em background:', err?.message || err))
                  .finally(() => prefetchInFlight.delete(nextId));
              }
            }
          }
        }
      }

      // O link do aviso é montado AQUI, por requisição — o cache guarda só o
      // texto (ver applyNoticeOrigin).
      const streams = applyNoticeOrigin(result.streams);
      // Lista que só tem aviso não é resultado: o cliente precisa perguntar de
      // novo em vez de ficar preso nela pelo cacheMaxAge normal.
      if (onlyNotice(result.streams) || streamsNeedRevalidation(result)) {
        return { streams, cacheMaxAge: 0 };
      }
      return {
        streams,
        cacheMaxAge: config.cacheTtl,
        staleRevalidate: config.cacheTtl * 4,
        staleError: 86400,
      };
    } catch (err) {
      log.error('[stream]', err);
      return { streams: [], cacheMaxAge: 0 };
    }
  });

  const addonInterface = builder.getInterface();

  // Servidor próprio em vez de serveHTTP: precisamos das rotas /resolve e
  // /configure ao lado das rotas do SDK.
  const app = express();

  // O Stremio chama isso ao dar play num stream de debrid. Resolver aqui (e não
  // na listagem) evita um directdl por torrent na hora da busca.
  async function resolveHandler(req: any, res: any) {
    // Normaliza caixa: infoHash é case-insensitive em magnet URI, e o debrid
    // e a assinatura trabalham sempre com minúsculas.
    const infoHash = String(req.params.infoHash || '').toLowerCase();
    if (!/^[a-f0-9]{40}$/i.test(infoHash)) {
      return res.status(400).send('infoHash inválido');
    }
    // Com debrid ativo a URL só vale assinada: hashes aparecem nos resultados
    // públicos dos indexers, e sem sig qualquer um montaria o link na mão.
    // Sem debrid não há conta a proteger (nem o que resolver). A dica de obra
    // (`w`) também entra na assinatura: adulterada, mudaria a escolha do
    // arquivo dentro de pack multi-obra.
    const hint = typeof req.query.w === 'string' ? req.query.w : '';
    if (debrid.current()) {
      const ep =
        req.query.s != null && req.query.e != null ? `?s=${req.query.s}&e=${req.query.e}` : '';
      if (!verifyResolve(infoHash, ep, req.query.sig, hint)) {
        return res.status(403).send('assinatura inválida');
      }
    }
    // Dica de obra assinada: nomes + ano para o pickFile escolher o arquivo
    // certo dentro de pack multi-obra. Ilegível = ausente — o pickFile cai no
    // comportamento antigo (maior vídeo) em vez de falhar o play.
    let work: { names: string[]; year: number | null; pack: boolean } | null = null;
    if (hint) {
      try {
        const parsed = JSON.parse(hint);
        const names = Array.isArray(parsed?.n) ? parsed.n.map(String).slice(0, 4) : [];
        if (names.length) work = { names, year: Number(parsed.y) || null, pack: parsed.p === 1 };
      } catch { /* dica ilegível: trata como ausente */ }
    }
    try {
      const adapter = debrid.current();
      const link = await debrid.resolveLink(infoHash, {
        season: req.query.s ? Number(req.query.s) : null,
        episode: req.query.e ? Number(req.query.e) : null,
        work,
      });
      if (!link) {
        // Torrent sem arquivo de vídeo: evidência DETERMINÍSTICA de magnet
        // quebrado — entra no banco para sair das próximas listas. Erro
        // transitório e pick falho (WorkPickError/EpisodePickError) NÃO
        // gravam: condenariam um hash bom por engano.
        if (adapter) magnetdb.markBad(adapter.id, runtime.opts().debridApiKey, infoHash);
        return res.status(404).send('nenhum arquivo de vídeo no torrent');
      }
      // Play que resolveu de verdade é a evidência mais forte de "vivo +
      // instantâneo": renova o histórico durável desta conta.
      if (adapter) magnetdb.markAlive(adapter.id, runtime.opts().debridApiKey, [infoHash]);
      return res.redirect(302, link);
    } catch (err) {
      if (isWorkPickError(err)) {
        return res.status(404).send('não foi possível identificar este filme dentro do pack');
      }
      if (isEpisodePickError(err)) {
        return res.status(404).send('este episódio não foi encontrado no pack');
      }
      log.error('[resolve]', err.message);
      return res.status(502).send('falha ao resolver no debrid');
    }
  }

  const CONFIGURE_PAGE = path.join(__dirname, 'public', 'configure.html');
  const DASHBOARD_PAGE = path.join(__dirname, 'public', 'dashboard.html');
  const sendConfigure = (_: any, res: any) => res.sendFile(CONFIGURE_PAGE);

  app.get('/health', (_, res) => res.json({ ok: true }));
  app.get('/logo.svg', (_, res) => res.sendFile(path.join(__dirname, 'public', 'logo.svg')));
  // Rasterizado do logo.svg. O manifest aponta pra cá porque o cliente do
  // Stremio não desenha SVG na lista de addons.
  app.get('/logo.png', (_, res) => res.sendFile(path.join(__dirname, 'public', 'logo.png')));
  app.get('/', (_, res) => res.redirect(302, '/configure'));
  app.get('/configure', sendConfigure);
  app.get('/dashboard', (_, res) => res.sendFile(DASHBOARD_PAGE));

  // Defaults do .env, para a página abrir já refletindo a instância. A chave do
  // debrid NUNCA vai junto: a página é pública e o .env é do operador, não de
  // quem está instalando.
  app.get('/defaults.json', async (_, res) => {
    const { debridApiKey, ...safe } = runtime.defaults();
    // `services` monta o seletor de debrid na página: a lista de serviços mora no
    // registry, não duplicada no HTML. `addonName` evita hardcodear a marca no
    // HTML — a página exibe o nome que vier da config.
    const jackettIndexers = await jackettCatalog.load();
    res.json({
      ...safe,
      jackettIndexersSelected: safe.jackettIndexers,
      jackettIndexers,
      debridApiKey: '',
      services: debrid.SERVICES,
      addonName: config.addonName,
      indexerTestEnabled: Boolean(config.jackett.testToken),
      // Liga o passo de selo na página; sem RESOLVE_SECRET não há o que cifrar.
      sealKeyEnabled: secretBox.enabled(),
    });
  });

  /**
   * Devolve o segmento de config com a chave de debrid cifrada. A página monta a
   * URL no navegador e não tem o RESOLVE_SECRET, então a troca acontece aqui.
   *
   * Público como o resto de /configure: selar não exige saber de nada e não
   * revela nada — é cifra, não decifra. Quem já tinha a chave para mandar aqui já
   * a tinha antes.
   */
  app.post('/seal-config', express.text({ type: () => true, limit: '16kb' }), (req, res) => {
    if (!secretBox.enabled()) {
      return res.status(503).json({ error: 'RESOLVE_SECRET não configurado' });
    }
    // `ok: true` garante o `release()` no finally; `ok: false` traz `status`.
    const admission = sealGate.enter('global') as GateAdmission;
    if (!admission.ok) return res.status(admission.status).json({ error: admission.error });

    try {
      const sealed = runtime.sealSegment(String(req.body || '').trim());
      if (!sealed) return res.status(400).json({ error: 'configuração inválida' });
      return res.json({ segment: sealed });
    } finally {
      admission.release();
    }
  });

  /**
   * Contadores e latências desde a subida do processo:
   *   curl -H "X-Indexer-Test-Token: $JACKETT_TEST_TOKEN" \
   *     http://127.0.0.1:7000/metrics.json
   *
   * Atrás do mesmo token do diagnóstico: não tem segredo dentro, mas revela quais
   * indexadores o operador usa e o ritmo de uso da instância — e a página de
   * configuração é pública.
   */
  app.get('/metrics.json', (req, res) => {
    if (!config.jackett.testToken) {
      return res.status(503).json({ error: 'métricas desativadas: defina JACKETT_TEST_TOKEN' });
    }
    if (!authorized(config.jackett.testToken, req.get('X-Indexer-Test-Token'))) {
      return res.status(401).json({ error: 'token de diagnóstico inválido' });
    }
    return res.json({
      ...metrics.snapshot(),
      logLevel: log.level(),
      cache: cache.snapshot(),
    });
  });

  /** Painel consolidado. A página é pública; estes dados continuam protegidos. */
  const dashboardStatusHandler: express.RequestHandler = async (req, res) => {
    if (!config.jackett.testToken) {
      return res.status(503).json({ error: 'dashboard desativado: defina JACKETT_TEST_TOKEN' });
    }
    if (!authorized(config.jackett.testToken, req.get('X-Indexer-Test-Token'))) {
      return res.status(401).json({ error: 'token de diagnóstico inválido' });
    }
    const admission = diagnosticGate.enter('global') as GateAdmission;
    if (!admission.ok) return res.status(admission.status).json({ error: admission.error });
    try {
      // O gate global é de UM por vez: um debrid fora do ar não pode segurar
      // o assento pelo timeout inteiro e congelar as ações do próprio painel.
      // A corrida degrada para `timeout` e a próxima rodada tenta de novo.
      const accountTimeout = new Promise((resolve) => {
        const timer = setTimeout(() => resolve({ ok: false, error: 'timeout consultando o debrid' }), 3000);
        timer.unref?.();
      });
      const [account, indexers] = await Promise.all([
        Promise.race([debrid.accountStatus(), accountTimeout]) as any,
        jackettCatalog.load(),
      ]);
      const metricSnapshot = metrics.snapshot();
      const hits = metricSnapshot.counters['cache.hit'] || 0;
      const misses = metricSnapshot.counters['cache.miss'] || 0;
      const memory = process.memoryUsage();
      const resolvers = RESOLVERS.map((resolver) => ({
        id: resolver.name,
        label: resolver.name,
        port: resolver.port + (Number(process.env.BR_RESOLVERS_PORT_OFFSET || 0) || 0),
        embedded: String(process.env.BR_RESOLVERS_EMBEDDED || 'true') === 'true',
        domain: process.env[resolver.siteEnv] || null,
      }));
      return res.json({
        generatedAt: new Date().toISOString(),
        general: {
          ok: true,
          version: config.version,
          uptimeS: metricSnapshot.uptimeS,
          memory: { rss: memory.rss, heapUsed: memory.heapUsed, heapTotal: memory.heapTotal },
          services: {
            addon: true,
            jackett: indexers.length > 0,
            debrid: Boolean(account?.ok),
            resolvers: resolvers.filter((item) => item.embedded).length,
          },
        },
        metrics: metricSnapshot,
        cache: {
          ...cache.snapshot(),
          persistent: String(process.env.CACHE_PERSIST || 'true') === 'true',
          hits,
          misses,
          hitRate: hits + misses > 0 ? hits / (hits + misses) : null,
          swrServed: metricSnapshot.counters['search.swr.served'] || 0,
        },
        debrid: { active: debrid.current()?.id || null, account, services: debrid.SERVICES },
        autofetch: { ...autofetch.snapshot(), ...autofetchStatus() },
        indexers,
        resolvers,
      });
    } finally {
      admission.release();
    }
  };
  app.get('/dashboard-status.json', dashboardStatusHandler);

  const dashboardActionHandler: express.RequestHandler = async (req, res) => {
    if (!config.jackett.testToken) {
      return res.status(503).json({ ok: false, error: 'dashboard desativado pelo operador' });
    }
    if (!authorized(config.jackett.testToken, req.get('X-Indexer-Test-Token'))) {
      return res.status(401).json({ ok: false, error: 'token de diagnóstico inválido' });
    }
    const action = String(req.body?.action || '');
    if (action !== 'sweep-dead' && action !== 'clear-cache') {
      return res.status(400).json({ ok: false, error: 'ação desconhecida' });
    }
    const admission = diagnosticGate.enter('global') as GateAdmission;
    if (!admission.ok) return res.status(admission.status).json({ ok: false, error: admission.error });
    try {
      if (action === 'clear-cache') {
        const entriesBefore = cache.size();
        cache.clear();
        metrics.count('dashboard.cache.clear');
        return res.json({ ok: true, action, entriesBefore, entriesAfter: cache.size() });
      }
      // A conta da instalação primeiro: quem abriu o painel com uma install URL
      // quer varrer a conta DELA. A do operador continua como retaguarda para o
      // painel aberto sem segmento de config.
      const result = (await debrid.sweepDeadCurrent()) ?? (await debrid.sweepDeadEnv());
      metrics.count('dashboard.sweep-dead');
      return res.json({
        ok: result != null,
        action,
        result,
        error: result == null ? 'varredura indisponível: o debrid ativo não implementa varredura, ou ela está desligada' : undefined,
      });
    } finally {
      admission.release();
    }
  };
  app.post('/dashboard-action.json', express.json({ limit: '4kb' }), dashboardActionHandler);

  /**
   * Testa um indexer pelo mesmo caminho da busca real. A página usa isso pro botão
   * de teste; serve também no terminal:
   *   curl "http://127.0.0.1:7000/test-indexer.json?id=bludv-cardigann"
   *
   * O `id` é validado contra o catálogo do Jackett em vez de ir cru pra URL: sem
   * isso qualquer string viraria um caminho na API do Jackett.
   */
  app.get('/test-indexer.json', async (req, res) => {
    if (!config.jackett.testToken) {
      return res.status(503).json({ ok: false, error: 'diagnóstico desativado pelo operador' });
    }
    if (!authorized(config.jackett.testToken, req.get('X-Indexer-Test-Token'))) {
      return res.status(401).json({ ok: false, error: 'token de diagnóstico inválido' });
    }
    // A stack passa pelo Caddy; limitar por req.ip trataria o proxy como se fosse
    // cada cliente. O teto é global de propósito e protege a única fila Jackett.
    // Mesma garantia do sealGate: o branch de `ok` decide o campo presente.
    const admission = diagnosticGate.enter('global') as GateAdmission;
    if (!admission.ok) return res.status(admission.status).json({ ok: false, error: admission.error });

    try {
      const id = String(req.query.id || '');
      const catalog = await jackettCatalog.load();
      if (!catalog.some((indexer) => indexer.id === id)) {
        return res.status(400).json({ ok: false, error: 'indexador desconhecido' });
      }
      // Sem `q`, quem escolhe o termo é o provider: indexer BR recebe o título em
      // português e o global o original. O teste é do indexer, não da query.
      const query = req.query.q ? String(req.query.q).slice(0, 80) : '';
      const type = req.query.type === 'series' ? 'series' : 'movie';
      return res.json(await jackett.test(id, query, type));
    } finally {
      admission.release();
    }
  });

  /**
   * Saúde da conta do debrid — o verificador que faltava.
   *
   * A conta encher é o que derruba a checagem de cache da AllDebrid (ela é um
   * /magnet/upload) e faz o ⚡ sumir de TODOS os streams; até estourar não há
   * sinal nenhum, e o sintoma na tela não aponta para a causa. Aqui dá para
   * ver antes:
   *
   *   curl -H "X-Indexer-Test-Token: $JACKETT_TEST_TOKEN" \
   *     http://127.0.0.1:7000/debrid-status.json
   *
   * Com a config na frente (/<config>/debrid-status.json) ele usa a chave
   * daquela instalação, que é a que o app manda — e não a do .env.
   */
  async function debridStatusHandler(req: any, res: any) {
    if (!config.jackett.testToken) {
      return res.status(503).json({ ok: false, error: 'diagnóstico desativado pelo operador' });
    }
    if (!authorized(config.jackett.testToken, req.get('X-Indexer-Test-Token'))) {
      return res.status(401).json({ ok: false, error: 'token de diagnóstico inválido' });
    }
    const status = await debrid.accountStatus();
    // 200 mesmo com a conta ruim: o corpo é o diagnóstico. Só falta de token
    // ou de serviço vira status de erro.
    return res.json(status);
  }

  app.get('/debrid-status.json', debridStatusHandler);
  app.get('/resolve/:infoHash', resolveHandler);
  // Captura o origin da requisição ANTES das duas montagens do router do SDK: o
  // `defineStreamHandler` não recebe o `req`, então o aviso de lista vazia só
  // tem como conhecer o origin por aqui. Fica acima do middleware de config para
  // o `run` mesclado preservar o origin na frente do `/:userConfig`.
  app.use((req, _res, next) => runtime.run({ origin: originOf(req) }, () => next()));

  // Rotas sem config: usam o .env puro. Vêm ANTES do prefixo genérico, senão
  // "/manifest.json" seria lido como um segmento de configuração.
  app.use(getRouter(addonInterface));

  /**
   * Instalação configurada, no modelo do Torrentio: `/<config>/manifest.json`.
   * O segmento é validado por `decode` — se não for uma config, cai no 404 normal
   * em vez de virar uma rota fantasma.
   */
  app.use('/:userConfig', (req, res, next) => {
    const parsed = runtime.decode(req.params.userConfig);
    // Sem 404 aqui, QUALQUER caminho de um segmento viraria um manifest válido
    // servindo a config do .env — inclusive erro de digitação no install URL.
    if (!parsed) return res.status(404).send('configuração inválida');
    runtime.run({ opts: parsed, encoded: req.params.userConfig }, () => next());
  });

  app.get('/:userConfig/configure', sendConfigure);
  app.get('/:userConfig/debrid-status.json', debridStatusHandler);
  // O painel também sob o segmento de config: sem ele, `debrid.current()` e o
  // `accountStatus` caem nos defaults do `.env` e a página mostra a conta do
  // operador no lugar da instalação que o usuário abriu.
  app.get('/:userConfig/dashboard', (_, res) => res.sendFile(DASHBOARD_PAGE));
  app.get('/:userConfig/dashboard-status.json', dashboardStatusHandler);
  app.post('/:userConfig/dashboard-action.json', express.json({ limit: '4kb' }), dashboardActionHandler);
  app.get('/:userConfig/resolve/:infoHash', resolveHandler);
  app.use('/:userConfig', getRouter(addonInterface));

  return { app, manifest, addonInterface };
}

export { createApp, streamsNeedRevalidation, originOf };
