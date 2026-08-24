import config from '../config.js';
import { accountScope } from '../utils/request-key.js';
import {
  json, pickFile, wait, batched,
  AuthError, isAuthError, QuotaError, isQuotaError,
} from './common.js';
import * as held from './protected.js';
import * as log from '../utils/logger.js';
import * as metrics from '../utils/metrics.js';
import { raceWithDeadline } from '../utils/deadline.js';
import { assertDubbedFiles, recordFileEvidence } from './audio-audit.js';
import { audioBucket } from '../utils/audio-quality.js';

// v4.1: a AllDebrid descontinuou /v4/magnet/status ("DISCONTINUED"), o que
// fazia toda resolução falhar com 502. upload e link/unlock respondem em ambas.
const API = 'https://api.alldebrid.com/v4.1';
const AGENT = 'stremio-adom';

/**
 * @param {string} apiKey
 * @param {string} path
 * @param {Object} [params]
 * @param {object} [options]
 * @param {string} [options.method]
 * @param {*} [options.body]
 * @param {number} [options.timeout]
 */
async function call(
  apiKey: string,
  path: string,
  params: Record<string, any> = {},
  { method = 'GET', body, timeout }: { method?: string; body?: any; timeout?: number } = {},
) {
  const url = new URL(`${API}${path}`);
  url.searchParams.set('agent', AGENT);
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) v.forEach((item) => url.searchParams.append(k, item));
    else url.searchParams.set(k, v);
  }

  const data = await json(url, {
    method,
    headers: { Authorization: `Bearer ${apiKey}` },
    body,
    timeout,
  });
  // A AllDebrid responde 200 com { status: "error" }; o HTTP sozinho não basta.
  if (data.status === 'error') {
    const code = data.error?.code || '';
    const message = data.error?.message || code || 'alldebrid retornou erro';
    const full = `${message}${code ? ` (${code})` : ''}`;
    // Nenhuma das duas é falha transitória: enquanto a chave não for trocada
    // (AUTH_*) ou a conta não for esvaziada (MAGNET_TOO_MANY_ACTIVE), toda
    // tentativa volta igual. Sobem classificadas para o orquestrador degradar
    // para P2P em vez de prometer um debrid que não vai resolver.
    if (isAuthError({ message: `${code} ${message}` })) throw new AuthError(full);
    if (isQuotaError({ message: `${code} ${message}` })) throw new QuotaError(full);
    throw new Error(message);
  }
  return data.data;
}

/**
 * Inventário de referência por conta: os hashes que JÁ estavam lá antes de o
 * addon começar a trabalhar.
 *
 * Ele existe porque o /magnet/upload é idempotente e não diz se criou ou
 * reaproveitou — a resposta é `{magnet, hash, name, size, ready, id}`, sem
 * data. Sem essa referência, limpar os prontos apagaria também o filme que o
 * usuário guardou de propósito na conta, na primeira vez que ele aparecesse
 * numa busca.
 *
 * O boot aquece a conta do operador em segundo plano; para uma chave que chega
 * na primeira requisição, o primeiro upload espera o snapshot para não arriscar
 * classificar magnet do usuário como nosso. A referência expira: usuário também
 * administra a conta fora do addon, e snapshot congelado autorizaria apagá-lo.
 */
interface PreexistingEntry {
  hashes: Set<string> | null;
  loadedAt: number;
  promise?: Promise<Set<string> | null>;
}

const preexisting = new Map<string, PreexistingEntry>();
// Upload é idempotente e a API não informa se criou ou reaproveitou o magnet.
// O que este processo submeteu nunca pode virar "preexistente" só porque o
// inventário assíncrono terminou depois do upload.
const submitted = new Map();

function rememberSubmitted(account: string, hash: string) {
  const normalized = String(hash || '').toLowerCase();
  if (!normalized) return;
  let hashes = submitted.get(account);
  if (!hashes) {
    hashes = new Set();
    submitted.set(account, hashes);
  }
  hashes.add(normalized);
}

function snapshotFresh(entry: PreexistingEntry | undefined) {
  if (!entry || entry.hashes === null) return false;
  const ttl = config.debrid.preexistingTtlMs;
  return ttl > 0 && Date.now() - entry.loadedAt < ttl;
}

/**
 * Espera o inventário sem deixá-lo mandar no prazo da resposta.
 *
 * O teto existe porque esta chamada não tem relação com o que a busca precisa
 * responder: ela mora dentro da reserva do debrid (`DEBRID_RESERVE_MS`), e um
 * `/magnet/status` lento — conta grande, incidente na AllDebrid — passaria a
 * estourar o prazo de toda busca. Vencido o teto, quem chamou segue com `null`:
 * os prontos ficam protegidos nesta passada e o snapshot, que continua
 * carregando em fundo, vale da próxima em diante.
 */
function waitInventory(promise: Promise<Set<string> | null> | undefined, timeoutMs?: number) {
  if (!promise) return Promise.resolve(null);
  const teto = Math.max(0, Math.min(timeoutMs ?? Number.POSITIVE_INFINITY, config.debridCheckFloor));
  if (!teto) return Promise.resolve(null);
  return raceWithDeadline(promise, teto, () => {
    metrics.count('debrid.inventory.timeout');
    return null;
  });
}

function knownBefore(apiKey: string, account: string): Set<string> | null {
  const entry = preexisting.get(account);
  if (snapshotFresh(entry)) return entry!.hashes;
  // Refresh já em voo: ninguém espera por ele aqui e ninguém usa a referência
  // velha — enquanto `hashes` for null, os prontos ficam protegidos.
  if (entry?.hashes === null) return null;

  // Enquanto o refresh está em voo, ninguém pode usar a referência velha para
  // apagar prontos. Falha de inventário mantém esse fail-safe e tenta de novo.
  const loading: PreexistingEntry = { hashes: null, loadedAt: 0 };
  preexisting.set(account, loading);
  loading.promise = call(apiKey, '/magnet/status')
    .then((data) => {
      const list = Array.isArray(data?.magnets) ? data.magnets : [];
      const snapshot = new Set<string>(list.map((m: any) => String(m.hash || '').toLowerCase()));
      const ours = submitted.get(account);
      const merged = ours?.size
        ? new Set([...snapshot].filter((hash) => !ours.has(hash)))
        : snapshot;
      loading.hashes = merged;
      loading.loadedAt = Date.now();
      log.info(
        `[alldebrid] ${merged.size} magnet(s) preexistente(s) na conta ficam protegidos da limpeza` +
          (ours?.size ? ` (${snapshot.size - merged.size} subido(s) pelo addon)` : ''),
      );
      return merged;
    })
    .catch((err) => {
      // Sem inventário não há o que proteger: a limpeza dos prontos continua
      // desligada, e a próxima busca tenta carregar de novo.
      log.warn('[alldebrid] não consegui inventariar a conta:', err.message);
      preexisting.delete(account);
      return null;
    });
  return null;
}

/** Pré-carrega o inventário do operador antes de qualquer upload no boot. */
function warmInventory(apiKey: string) {
  if (!apiKey) return Promise.resolve(null);
  const account = accountScope(apiKey);
  knownBefore(apiKey, account);
  return preexisting.get(account)?.promise || Promise.resolve(null);
}

// Limpeza em fila curta, com uma segunda tentativa.
//
// Disparar os ~50 deletes de uma checagem em paralelo fazia a AllDebrid
// devolver 503 (página HTML, não JSON) em parte deles — medido: 13 de 45 numa
// única busca. Cada 503 é um magnet que fica na conta para sempre, e como a
// conta cheia derruba a própria checagem de cache, o erro se realimenta.
const DROP_CONCURRENCY = 4;

async function dropMagnets(apiKey: string, ids: Array<string | number>) {
  const falhas: any[] = [];
  let ok = 0;
  const alvo = [...ids];
  const worker = async () => {
    while (alvo.length) {
      const id = alvo.shift();
      try {
        await call(apiKey, '/magnet/delete', { id });
        ok += 1;
      } catch (primeira) {
        // 503 é o sintoma de rajada, não de id inválido: uma pausa curta
        // costuma bastar. Falhou de novo, aí é falha de verdade e entra na
        // contagem em vez de sumir no allSettled.
        try {
          await wait(400);
          await call(apiKey, '/magnet/delete', { id });
          ok += 1;
        } catch (segunda) {
          falhas.push(segunda);
        }
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(DROP_CONCURRENCY, alvo.length) }, worker),
  );
  return { ok, falhas };
}
// Estados dos quais a AllDebrid não volta: o torrent não vai baixar.
const DEAD = /no peer|expired|not available|error|failed/i;

/**
 * Varre da conta os magnets em estado terminal.
 *
 * A limpeza do checkCached só alcança hashes que estão NA busca do momento.
 * Um torrent que morreu (sem peer, expirado) e nunca mais é pesquisado fica
 * ocupando vaga para sempre — e vaga é o recurso que, esgotado, faz a conta
 * recusar até o /magnet/delete que a consertaria.
 *
 * Não consulta o inventário de preexistentes de propósito: magnet em estado
 * terminal não é acervo de ninguém. O `held` continua valendo, para não
 * matar um download do autofetch que a conta marcou cedo demais.
 */
async function sweepDead(apiKey: string, { minAgeMs = config.debrid.sweepDeadMinAgeMs } = {}) {
  const account = accountScope(apiKey);
  const data = await call(apiKey, '/magnet/status');
  const list = Array.isArray(data?.magnets) ? data.magnets : [];
  const limite = Date.now() - Math.max(0, Number(minAgeMs) || 0);

  const alvo = list.filter((m: any) => {
    if (!DEAD.test(String(m.status || ''))) return false;
    if (!m.id) return false;
    if (held.isHeld(m.hash, account)) return false;
    // uploadDate vem em segundos; sem data, trata como antigo o bastante.
    const quando = Number(m.uploadDate || 0) * 1000;
    return !quando || quando <= limite;
  });

  if (!alvo.length) return { varridos: 0, falhas: 0 };
  const { ok, falhas } = await dropMagnets(apiKey, alvo.map((m: any) => m.id));
  metrics.count('debrid.swept', ok);
  if (falhas.length) {
    log.warn(
      `[alldebrid] varredura: ${ok}/${alvo.length} magnet(s) morto(s) removido(s) — ${falhas.length} falhou(ram): ${falhas[0]?.message || falhas[0]}`,
    );
  } else {
    log.info(`[alldebrid] varredura: ${ok} magnet(s) morto(s) removido(s) da conta`);
  }
  return { varridos: ok, falhas: falhas.length };
}

/**
 * Varre da conta os magnets ANTIGOS sem áudio PT (balde `lixo` do
 * `audioBucket`): legendado ou estrangeiro que o autofetch acumulou antes do
 * filtro de áudio existir. É a única limpeza que alcança o que nem está morto
 * nem aparece mais em busca — está pronto, só não serve a este addon.
 *
 * Por ser destrutiva sobre conteúdo TOCÁVEL, as travas andam juntas:
 *   - idade mínima (só o que passou de `sweepUndubbedMinAgeMs`);
 *   - `held` (download do autofetch em curso);
 *   - `knownBefore` (o acervo que já era do usuário);
 *   - sem data de upload, a idade não está PROVADA — fica (diferente do
 *     sweepDead: morto é lixo em qualquer idade; tocável exige prova).
 *
 * FAIL-SAFE: inventário frio ou falho (`knownBefore === null`) pula a rodada
 * inteira — mesmo padrão do dropReady: sem prova de proveniência, nada sai.
 */
async function sweepUndubbed(
  apiKey: string,
  {
    minAgeMs = config.debrid.sweepUndubbedMinAgeMs,
    max = config.debrid.sweepUndubbedMax,
  }: { minAgeMs?: number; max?: number } = {},
): Promise<{ varridos: number; falhas: number; pulado?: string }> {
  const account = accountScope(apiKey);
  const preexistentes = knownBefore(apiKey, account);
  if (preexistentes === null) {
    log.info('[alldebrid] varredura de não-dublados pulada: inventário frio ou falhou');
    return { varridos: 0, falhas: 0, pulado: 'inventário frio' };
  }

  const data = await call(apiKey, '/magnet/status');
  const list = Array.isArray(data?.magnets) ? data.magnets : [];
  const limite = Date.now() - Math.max(0, Number(minAgeMs) || 0);

  const alvo = list.filter((m: any) => {
    if (!m.id) return false;
    if (held.isHeld(m.hash, account)) return false;
    if (preexistentes.has(String(m.hash || '').toLowerCase())) return false;
    if (audioBucket(String(m.filename || '')) !== 'lixo') return false;
    // uploadDate vem em segundos; sem data, não há prova de idade — fica.
    const quando = Number(m.uploadDate || 0) * 1000;
    return quando > 0 && quando <= limite;
  });

  if (!alvo.length) return { varridos: 0, falhas: 0 };
  // Teto por rodada: os mais antigos saem primeiro — o corte pega o resto.
  alvo.sort((a: any, b: any) => Number(a.uploadDate || 0) - Number(b.uploadDate || 0));
  const corte = alvo.slice(0, Math.max(0, Math.trunc(Number(max) || 0)));
  if (!corte.length) return { varridos: 0, falhas: 0 };

  const { ok, falhas } = await dropMagnets(apiKey, corte.map((m: any) => m.id));
  metrics.count('debrid.swept.undubbed', ok);
  if (falhas.length) {
    log.warn(
      `[alldebrid] varredura de não-dublados: ${ok}/${corte.length} removido(s) — ${falhas.length} falhou(ram): ${falhas[0]?.message || falhas[0]}`,
    );
  } else {
    log.info(`[alldebrid] varredura de não-dublados: ${ok} magnet(s) antigo(s) sem áudio PT removido(s)`);
  }
  return { varridos: ok, falhas: falhas.length };
}
/**
 * O /magnet/instant foi removido, mas o próprio /magnet/upload responde
 * `ready` por magnet — é essa a checagem de cache da AllDebrid. Aceita lote.
 *
 * O que não está pronto é removido em seguida: sem isso cada consulta deixaria
 * um download rodando na conta (chegaram a 226 fantasmas antes disso existir).
 *
 * O que ESTÁ pronto também sai, e essa é a diferença que segura a conta: cada
 * busca sobe dezenas de hashes e os prontos ficavam para sempre — 2300 magnets
 * em quatro dias de uso, até bater o teto da AllDebrid e derrubar a checagem
 * inteira (aí o ⚡ some de TODOS os streams). Apagar é seguro porque o cache é
 * do serviço, não da conta: no play o upload traz de volta na hora. Ficam de
 * fora os do autofetch (`held`) e os que já eram do usuário (`knownBefore`).
 *
 * @param {string} apiKey
 * @param {string[]} infoHashes
 * @param {object} [options]
 * @param {number} [options.timeoutMs]
 */
async function checkCached(apiKey: string, infoHashes: string[], { timeoutMs }: { timeoutMs?: number } = {}) {
  const dropReady: Array<string | number> = [];
  const dropDownload: Array<string | number> = [];
  const account = accountScope(apiKey);
  const hadInventory = preexisting.has(account);
  // `knownBefore` já dispara o refresh quando o snapshot vence e devolve null
  // enquanto ele não chega: referência vencida nunca autoriza apagar nada.
  let preexistentes = config.debrid.dropReady ? knownBefore(apiKey, account) : null;
  const loading = preexisting.get(account);
  if (!hadInventory && loading?.hashes === null) {
    // Não há proveniência na resposta idempotente do upload. Antes de subir o
    // primeiro lote desta conta, esperamos o inventário para não confundir um
    // magnet que já era do usuário com um que a busca acabou de criar. Mantém o
    // fail-safe: a primeira checagem ainda não remove prontos.
    //
    // Só o PRIMEIRO inventário é esperado. O refresh por TTL roda em fundo e
    // vale da próxima busca em diante: aguardá-lo aqui punia uma busca a cada
    // `ALLDEBRID_PREEXISTING_TTL_MS` com uma chamada de rede inteira dentro da
    // reserva do debrid — e, com o `/magnet/status` fora do ar, TODA busca,
    // porque a falha limpa o registro e a próxima passada tenta de novo.
    preexistentes = (await waitInventory(loading.promise, timeoutMs)) || null;
  }
  const skipReadyDrop = !hadInventory;

  const result = await batched(infoHashes, config.debrid.batchSize, async (batch: string[], ctx?: { timeoutMs?: number }) => {
    const data = await call(
      apiKey,
      '/magnet/upload',
      { 'magnets[]': batch },
      { timeout: ctx?.timeoutMs ?? config.debrid.cacheCheckTimeout },
    );
    const ready: string[] = [];
    for (const magnet of data?.magnets || []) {
      const hash = String(magnet.hash || '').toLowerCase();
      rememberSubmitted(account, hash);
      if (magnet.ready) {
        ready.push(hash);
        // Só entra na limpeza o que o inventário garante não ser do usuário.
        if (!skipReadyDrop && preexistentes && magnet.id && !preexistentes.has(hash) && !held.isHeld(magnet.hash, account)) {
          dropReady.push(magnet.id);
        }
      // Hash em download automático não entra na limpeza: ele está "não pronto"
      // justamente porque pedimos que baixasse.
       } else if (magnet.id && !held.isHeld(magnet.hash, account)) dropDownload.push(magnet.id);
    }
    return ready;
  }, { timeoutMs });

  const scheduleDrop = (ids: Array<string | number>, kind: 'prontos' | 'downloads') => {
    if (!ids.length) return;
    // Sem travar a busca: limpeza é efeito colateral, não resposta.
    // O resultado É lido — antes o allSettled engolia a rejeição, o log contava
    // TENTATIVA como remoção, e a conta crescia enquanto o addon afirmava estar
    // limpando. Ver dropMagnets: as falhas eram 503 por rajada.
    dropMagnets(apiKey, ids).then(({ ok, falhas }) => {
      metrics.count('debrid.dropped', ok);
      if (kind === 'downloads') metrics.count('debrid.dropped.download', ok);
      if (falhas.length) {
        metrics.count('debrid.drop_failed', falhas.length);
        const motivo = falhas[0]?.message || String(falhas[0]);
        log.warn(
          `[alldebrid] ${ok}/${ids.length} magnet(s) ${kind} removido(s) da conta — ${falhas.length} falhou(ram): ${motivo}`,
        );
        return;
      }
      log.info(`[alldebrid] ${ok} magnet(s) ${kind} da checagem removido(s) da conta`);
    });
  };
  if (config.debrid.dropReady) scheduleDrop(dropReady, 'prontos');
  if (config.debrid.dropUncached) scheduleDrop(dropDownload, 'downloads');
  return result;
}

/**
 * Na v4.1 os arquivos vêm como árvore, não como lista de links: `n` é o nome,
 * `e` são as entradas de uma pasta, e a folha traz `s` (tamanho) e `l` (link).
 */
function flattenFiles(nodes: any[], prefix = '') {
  const out: any[] = [];
  for (const node of nodes || []) {
    const path = prefix ? `${prefix}/${node.n}` : node.n;
    if (Array.isArray(node.e)) {
      out.push(...flattenFiles(node.e, path));
    } else if (node.l) {
      out.push({ path, size: node.s, link: node.l });
    }
  }
  return out;
}

/**
 * @param {string} apiKey
 * @param {string} infoHash
 * @param {object} [options]
 * @param {?number} [options.season]
 * @param {?number} [options.episode]
 * @param {*} [options.work]
 */
async function resolveLink(apiKey: string, infoHash: string, { season, episode, work, dubbed }: { season?: number | null; episode?: number | null; work?: any; dubbed?: boolean } = {}) {
  const account = accountScope(apiKey);
  const upload = await call(apiKey, '/magnet/upload', { 'magnets[]': infoHash });
  const magnet = (upload?.magnets || [])[0];
  if (!magnet?.id) return null;

  let status = await call(apiKey, '/magnet/status', { id: magnet.id });
  let info = status?.magnets;
  // A resposta às vezes vem como lista de um item só.
  if (Array.isArray(info)) info = info[0];

  // Em cache, vira "Ready" na hora. Se não, o torrent entraria em download e o
  // play ficaria travado — melhor devolver nada e deixar escolher outro.
  for (let attempt = 0; attempt < 3 && info && info.status !== 'Ready'; attempt += 1) {
    await wait(700);
    status = await call(apiKey, '/magnet/status', { id: magnet.id });
    info = Array.isArray(status?.magnets) ? status.magnets[0] : status?.magnets;
  }
  if (!info || info.status !== 'Ready') {
    log.warn(`[alldebrid] torrent não está em cache (status: ${info?.status})`);
    // Sem isso o magnet fica baixando na conta pra sempre: como a AllDebrid não
    // tem consulta de cache, TODO play que falha deixa um download fantasma
    // (foram 226 acumulados até este bug aparecer). O upload é idempotente,
    // então apagar não custa nada — se o usuário voltar, ele é reenviado.
    // Idem no play: se o usuário clicou num BR que está baixando por nossa
    // conta, apagar aqui jogaria fora o progresso.
    if (config.debrid.dropUncached && !held.isHeld(infoHash, account)) {
      try {
        await call(apiKey, '/magnet/delete', { id: magnet.id });
      } catch (err) {
        log.warn('[alldebrid] não consegui remover o magnet:', err.message);
      }
    }
    return null;
  }

  const files = flattenFiles(info.files);
  const file = pickFile(files, { season, episode, work });
  recordFileEvidence(infoHash, files);
  assertDubbedFiles(files, Boolean(dubbed));
  if (!file) return null;

  const unlocked = await call(apiKey, '/link/unlock', { link: file.link });
  return unlocked?.link || null;
}

/**
 * O /magnet/upload já é o próprio "começa a baixar" da AllDebrid: o mesmo
 * endpoint que responde `ready` para o cache é o que enfileira o que não está.
 */
async function enqueue(apiKey: string, infoHash: string) {
  const data = await call(apiKey, '/magnet/upload', { 'magnets[]': infoHash });
  if (data?.magnets?.length) rememberSubmitted(accountScope(apiKey), infoHash);
  return Boolean(data?.magnets?.length);
}

/**
 * Ocupação da conta, por estado. Serve ao verificador: encher é o que derruba
 * a checagem de cache (que é um upload) e faz o ⚡ sumir da lista inteira, e
 * até estourar não existe nenhum sinal — o erro só chega quando já é tarde.
 *
 * Sem percentual: a AllDebrid tem DOIS limites que não batem entre si e nenhum
 * dos dois é consultável. A doc documenta `MAGNET_TOO_MANY_ACTIVE` como
 * "maximum allowed active magnets (30)", enquanto a mensagem que derrubou esta
 * conta na prática dizia "Magnets limit reached (1000 accross all tabs)" — e a
 * conta tinha 2309 registros funcionando. Inventar "% ocupado" sobre um teto
 * que não conhecemos dizia "231% ocupado" para uma conta que respondia normal.
 * Melhor relatar o que dá para medir e deixar o limiar explícito.
 */
const ACTIVE_STATES = /^(?:queued|downloading|processing|compressing|moving|uploading)$/i;

async function accountStatus(apiKey: string) {
  const data = await call(apiKey, '/magnet/status');
  const magnets = Array.isArray(data?.magnets) ? data.magnets : [];

  let ready = 0;
  let active = 0;
  let error = 0;
  for (const magnet of magnets) {
    const status = String(magnet.status || '');
    if (magnet.ready || /^ready$/i.test(status)) ready += 1;
    else if (ACTIVE_STATES.test(status)) active += 1;
    else if (status) error += 1;
  }

  return {
    magnets: magnets.length,
    ready,
    active,
    error,
    oldestAt: magnets.reduce(
      (min: any, m: any) => (m.uploadDate && (!min || m.uploadDate < min) ? m.uploadDate : min),
      null,
    ),
  };
}

/**
 * Inventário PRONTO da conta (`{ title, infoHash, size }`): base da
 * conta-como-fonte. Só o que já está pronto interessa — o que ainda baixa não
 * é tocável e não deve aparecer como stream.
 *
 * Entrada cujo filename É o próprio hash é magnet sem metadado resolvido
 * (5 no inventário real medido): título vazio não casa com obra nenhuma.
 */
async function inventory(apiKey: string) {
  const data = await call(apiKey, '/magnet/status');
  const list = Array.isArray(data?.magnets) ? data.magnets : [];
  const out: any[] = [];
  for (const magnet of list) {
    // Mesmo critério de "pronto" do accountStatus: `ready` ou status Ready.
    if (!(magnet.ready || /^ready$/i.test(String(magnet.status || '')))) continue;
    const infoHash = String(magnet.hash || '').toLowerCase();
    const title = String(magnet.filename || '').trim();
    if (!infoHash || !title) continue;
    if (title.toLowerCase() === infoHash) continue;
    out.push({ title, infoHash, size: Number(magnet.size) || 0 });
  }
  return out;
}

/**
 * Status detalhado de torrents na conta para o ciclo de recheck / detecção de mortos.
 */
async function torrentStatus(apiKey: string, _infoHashes?: string[]) {
  const data = await call(apiKey, '/magnet/status');
  const list = Array.isArray(data?.magnets) ? data.magnets : [];
  const out: Record<string, { state: 'ready' | 'downloading' | 'dead' | 'unknown'; id?: any }> = {};
  for (const magnet of list) {
    const hash = String(magnet.hash || '').toLowerCase();
    if (!hash) continue;
    let state: 'ready' | 'downloading' | 'dead' | 'unknown' = 'unknown';
    const statusStr = String(magnet.status || '');
    if (magnet.ready || /^ready$/i.test(statusStr)) {
      state = 'ready';
    } else if (DEAD.test(statusStr)) {
      state = 'dead';
    } else if (ACTIVE_STATES.test(statusStr)) {
      state = 'downloading';
    }
    out[hash] = { state, id: magnet.id };
  }
  return out;
}

/**
 * Remove torrent específico pelo id na AllDebrid.
 */
async function removeTorrent(apiKey: string, id: any) {
  try {
    await call(apiKey, '/magnet/delete', { id });
    return true;
  } catch (err) {
    log.warn(`[alldebrid] falha ao remover torrent ${id}:`, err?.message || err);
    return false;
  }
}

export const id = 'alldebrid';
export const label = 'AllDebrid';
export const short = 'AD';
// Não pelo /magnet/instant (removido), e sim pelo `ready` do /magnet/upload.
export const cacheCheck = true;
// A consulta cria transferência; ela disputa o prazo sem ser abortada e segue
// em background para ler os ids e remover os magnets que não estavam prontos.
export const abortSafeCacheCheck = false;
export const keyUrl = 'https://alldebrid.com/apikeys';
export { enqueue, accountStatus, inventory, checkCached, warmInventory, sweepDead, sweepUndubbed, resolveLink, torrentStatus, removeTorrent };

