// Oráculo multi-fonte de disponibilidade do Real-Debrid.
//
// O CDN/cache do RD pertence ao SERVIÇO, não à conta: se um hash está
// cacheado para uma chave, está para todas. Este módulo despacha consultas
// às fontes habilitadas (StremThru, Torrentio) em paralelo e funde os
// resultados. Qualquer erro devolve Map vazio — nunca lança.
//
// Regra de fusão: true de qualquer fonte vence (evidência positiva). false só
// conta de fonte que enumera com autoridade: Torrentio listado sem [RD+] a
// partir do HASH SOLICITADO. Hash que NÃO está no conjunto pedido (ou não
// listado) é DESCONHECIDO, nunca miss — o acervo BR dublado que interessa é
// justamente o que ele não indexa.
//
// O `status` do StremThru é TRI-ESTADO: `cached` é hit, um negativo explícito
// é miss, e `unknown` NÃO produz veredicto — é o serviço
// dizendo que não sabe (instância recém-subida responde isso para quase tudo),
// e traduzir isso em miss envenenaria o ledger global por até 3 dias.
//
// Deadlines: a chamada tem UM único prazo (deadlineAt), calculado uma vez em
// `check()`. Cada fonte usa APENAS o tempo restante desse prazo — nunca
// multiplica o timeout por lote/fonte. Um lote StremThru que esgotaria o
// deadline não é iniciado; o Torrentio usa o mesmo restante no seu fetch.
import config from '../config.js';
import * as cache from '../utils/cache.js';
import * as metrics from '../utils/metrics.js';
import * as log from '../utils/logger.js';
import { prefix } from '../utils/cache-keys.js';
import * as rdLedger from './rd-ledger.js';

export type OracleQuery = {
  hashes: string[];
  type: 'movie' | 'series';
  id: string; // imdbId, com :S:E quando série
  timeoutMs: number;
  // Marca temporal ABSOLUTA (ms desde epoch) do fim da chamada total. `check()`
  // calcula uma única vez e injeta; as fontes só leem o restante. É opcional no
  // tipo porque o chamador pode não montar (o `check` preenche) e a pipeline
  // passa `timeoutMs`.
  deadlineAt?: number;
};

type OracleSource = {
  name: string;
  check: (q: OracleQuery, apiKey?: string) => Promise<Map<string, boolean>>;
};

/** Milissegundos restantes até o deadline compartilhado (mínimo 1). */
function remainingMs(deadlineAt?: number): number {
  if (!deadlineAt) return Number.MAX_SAFE_INTEGER;
  return Math.max(1, deadlineAt - Date.now());
}

// ─── StremThru ───────────────────────────────────────────────────────────────

/** Status que o StremThru usa para afirmar cache. Só o que foi visto em resposta real. */
const STREMTHRU_POSITIVE = new Set(['cached']);
/**
 * Status que afirmam AUSÊNCIA de cache. Diferente de `unknown`, estes são
 * negativos inequívocos: o serviço afirma que o hash não está no cache, e
 * honrar isso como miss é correto.
 *
 * Ressalva: nenhum deles apareceu ainda numa resposta CAPTURADA — a fixture de
 * 2026-08-26 só traz `cached` e `unknown`. Estão aqui porque o custo de errar é
 * nulo (token inexistente nunca casa), ao contrário de `unknown`, cujo erro
 * gravava miss durável. A métrica em checkStremthru revela o vocabulário real.
 */
const STREMTHRU_NEGATIVE = new Set<string>(['uncached', 'not_cached']);

async function checkStremthru(q: OracleQuery, apiKey?: string): Promise<Map<string, boolean>> {
  const { stremthruUrl, stremthruToken, stremthruStore, maxHashes } = config.debrid.rdOracle;
  if (!stremthruUrl) return new Map();

  // Chave da fonte tem precedência; vazia, usa a apiKey efetiva da instalação
  // recebida por rdOracle.check. Nunca logamos este valor.
  const effectiveToken = stremthruToken || apiKey || '';

  const result = new Map<string, boolean>();
  const batchSize = Math.min(500, Math.max(1, maxHashes));
  const targetHashes = q.hashes.slice(0, 500);
  let totalBatches = 0;
  let failedBatches = 0;

  // Lotes de batchSize; StremThru aceita até 500 por chamada. Cada lote usa só o
  // tempo RESTANTE do deadline único e não inicia lote depois que ele esgotou.
  for (let i = 0; i < targetHashes.length; i += batchSize) {
    if (Date.now() >= (q.deadlineAt ?? Infinity)) break;
    totalBatches += 1;
    const batch = targetHashes.slice(i, i + batchSize);
    const url = `${stremthruUrl}/v0/store/torz/check?hash=${batch.join(',')}`;
    const headers: Record<string, string> = {
      'X-StremThru-Store-Name': stremthruStore,
      'X-StremThru-Store-Authorization': `Bearer ${effectiveToken}`,
    };
    try {
      const res = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(remainingMs(q.deadlineAt)),
      });
      if (!res.ok) {
        failedBatches += 1;
        continue;
      }
      const body = await res.json() as any;
      const items: any[] = body?.data?.items || [];
      // O `status` do StremThru é TRI-ESTADO, não booleano. A fixture real de
      // 2026-08-26 traz `cached` e `unknown` no mesmo envelope: `unknown` é o
      // serviço dizendo que NÃO SABE — instância nova responde isso para quase
      // tudo, porque o banco dela começa vazio. Traduzir isso em `false` fazia
      // o pipeline gravar miss no ledger GLOBAL com backoff de até 3 dias, que
      // é o oposto da regra deste módulo ("desconhecido nunca vira miss").
      //
      // Só token confirmado contra resposta real decide. Nenhum negativo
      // explícito foi observado até agora, então NEGATIVE está vazio de
      // propósito: acrescente aqui quando a métrica abaixo revelar um. Status
      // fora dos dois conjuntos não produz veredicto nenhum.
      for (const item of items) {
        const hash = String(item?.hash || '').toLowerCase();
        if (!hash) continue;
        const status = String(item?.status || '').toLowerCase();
        if (STREMTHRU_POSITIVE.has(status)) {
          result.set(hash, true);
        } else if (STREMTHRU_NEGATIVE.has(status)) {
          result.set(hash, false);
        } else if (status !== 'unknown') {
          // Vocabulário novo: conta para aparecer no dump de métricas em vez de
          // ser engolido em silêncio como o `unknown` foi.
          metrics.count(`debrid.rd.oracle.stremthruStatus.${status.replace(/[^a-z0-9_]/g, '') || 'vazio'}`);
        }
      }
    } catch {
      failedBatches += 1;
      /* fail-open: timeout/rede → sem veredicto */
    }
  }
  if (totalBatches > 0 && failedBatches === totalBatches) {
    log.warn(`[rd-oracle] StremThru indisponível: todos os ${totalBatches} lote(s) falharam`);
  }
  return result;
}

// ─── Torrentio ───────────────────────────────────────────────────────────────

const HASH_RE = /^[a-f0-9]{40}$/;

/** Todos os candidatos de 40-hex num URL (o token apiKey também é 40-hex). */
function hashCandidatesFromUrl(url: string): string[] {
  return (String(url).match(/[a-f0-9]{40}/gi) || []).map((h) => h.toLowerCase());
}

function torrentioCacheKey(type: string, id: string) {
  return `${prefix('rdt')}trt:${type}:${id}`;
}

async function checkTorrentio(q: OracleQuery, apiKey?: string): Promise<Map<string, boolean>> {
  const { torrentioUrl, torrentioKey, torrentioTtl } = config.debrid.rdOracle;
  if (!torrentioUrl) return new Map();

  // Só aceitamos hash que o chamador pediu. O token (apiKey no path) também é
  // 40-hex; o antigo "primeiro 40-hex" confundia token com hash real. Analisamos
  // os segmentos do URL e selecionamos o candidato pertencente ao conjunto pedido.
  const requested = new Set(q.hashes.map((h) => String(h).toLowerCase()));

  // Filtra um Map pelo conjunto SOLICITADO. O cache por título guarda TODAS as
  // respostas da obra, inclusive hashes que esta chamada não pediu (ou que o
  // ledger, dedupe do caller, já resolveu — simplesmente não estão em q.hashes).
  // Devolvê-los inteiros deixaria o pipeline re-aplicar noteHit/noteMiss com
  // evidência desta obra de outra consulta e até rebaixar um hit que já virou
  // hit global — por isso o retorno cacheado passa SEMPRE por este filtro.
  const onlyRequested = (map: Map<string, boolean>): Map<string, boolean> => {
    const out = new Map<string, boolean>();
    for (const [hash, cached] of map) {
      if (requested.has(hash)) out.set(hash, cached);
    }
    return out;
  };

  // Cache por título: uma chamada por obra, TTL ~6h. É infra de terceiro;
  // não pode virar uma chamada por busca repetida.
  const cacheKey = torrentioCacheKey(q.type, q.id);
  const cached = cache.get(cacheKey) as Array<[string, boolean]> | Map<string, boolean> | null;
  if (cached instanceof Map) return onlyRequested(cached);
  if (Array.isArray(cached)) return onlyRequested(new Map<string, boolean>(cached));

  const effectiveKey = torrentioKey || apiKey || '';
  if (!effectiveKey) return new Map();

  // O segmento de config do Torrentio é TEXTO PURO `realdebrid=<key>`, não
  // base64url (medido ao vivo hoje). A chave viaja crua no path — nunca logada.
  const configSegment = `realdebrid=${effectiveKey}`;
  const url = `${torrentioUrl}/${configSegment}/stream/${q.type}/${q.id}.json`;

  const result = new Map<string, boolean>();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(remainingMs(q.deadlineAt)) });
    if (!res.ok) return result;
    const body = await res.json() as any;
    const streams: any[] = body?.streams || [];

    for (const stream of streams) {
      const name: string = stream?.name || '';
      // Candidatos: infoHash direto (quando presente) somado aos segmentos 40-hex
      // do URL de resolve. O hash válido é o que pertence ao conjunto pedido —
      // stream cujo hash não pedimos é pulado (fica desconhecido para o chamador).
      const candidates: string[] = [];
      if (stream?.infoHash && HASH_RE.test(String(stream.infoHash).toLowerCase())) {
        candidates.push(String(stream.infoHash).toLowerCase());
      }
      if (stream?.url) candidates.push(...hashCandidatesFromUrl(stream.url));
      const hash = candidates.find((c) => requested.has(c)) || '';
      if (!hash) continue;

      // [RD+] exato no início do name = cacheado no RD. `[RD]` sozinho e
      // `[RD download]` NÃO são hit — `[RD download]` listado é miss autoritativo.
      if (/^\[RD\+\]/i.test(name)) {
        result.set(hash, true);
      } else {
        // Listado sem o marcador de cacheado = miss autoritativo (Torrentio sabe
        // que não está pronto para esta chave).
        result.set(hash, false);
      }
    }

    // Hashes que pedimos e o Torrentio NÃO listou (nem via infoHash nem via URL)
    // não entram no Map → o caller os trata como DESCONHECIDOS. O acervo BR
    // dublado que interessa é justamente o que o Torrentio não indexa — tratar
    // como miss envenenaria o ledger.

    // Salva no cache para não repetir a chamada (array p/ serializar no L2).
    if (torrentioTtl > 0) cache.set(cacheKey, Array.from(result.entries()), torrentioTtl);
  } catch { /* fail-open */ }
  return result;
}

// ─── Despachante ─────────────────────────────────────────────────────────────

const sources: OracleSource[] = [
  { name: 'stremthru', check: checkStremthru },
  { name: 'torrentio', check: checkTorrentio },
];

/**
 * True se ao menos uma fonte está de fato utilizável com credencial efetiva.
 *
 * Exige: oráculo ligado E um endpoint configurado E (token/key explícitos da
 * fonte OU apiKey efetiva da instalação). Sem credencial alguma, nenhuma fonte
 * responde pela conta → `false` (RD continua honesto "não sei"). Apesar do
 * nome, o flag do `current()` é por requisição (víamos o `debridApiKey`); não
 * chame sem passar a chave quando ela existir no contexto.
 */
export function available(apiKey?: string): boolean {
  if (!config.debrid.rdOracle.enabled) return false;
  const { stremthruUrl, stremthruToken, torrentio, torrentioKey, torrentioUrl } = config.debrid.rdOracle;
  const stremthruLive = Boolean(stremthruUrl) && Boolean(stremthruToken || apiKey);
  const torrentioLive = Boolean(torrentioUrl && torrentio) && Boolean(torrentioKey || apiKey);
  return stremthruLive || torrentioLive;
}

/**
 * Consulta fontes habilitadas em paralelo e funde resultados.
 * true de qualquer fonte vence; false só de enumeração autoritativa.
 *
 * O retorno carrega APENAS os hashes com veredicto novo nesta chamada (fonte
 * externa ou cache por título). Estados que o ledger já sabe
 * (hit/miss/blocked) ficam de fora: o resultado alimenta
 * o loop de escrita do pipeline (noteHit/noteMiss), e ecoar um miss do próprio
 * ledger faria a pipeline reescrever o mesmo miss com evidência fantasma —
 * avançando `n`/`at` a cada reabertura da mesma lista. `blocked` também não é
 * ecoado, então segue dominante sem risco de ser tocado por um caminho atrasado.
 * Erro devolve Map vazio — nunca lança.
 */
export async function check(q: OracleQuery, apiKey?: string): Promise<Map<string, boolean>> {
  if (!config.debrid.rdOracle.enabled) return new Map();

  const started = Date.now();
  metrics.count('debrid.rd.oracle.called');

  // Deadlines ÚNICO de toda a chamada, compartilhado pelas fontes em paralelo:
  // calculado aqui (não somado por fonte/lote, não multiplicado por batch).
  const deadlineAt = Date.now() + q.timeoutMs;

  // Só hashes que o ledger ainda não decidiu vão à rede. Já resolvidos
  // (hit/miss/blocked) não pagam chamada E não entram no resultado — o
  // pipeline não tem nada novo a gravar para eles.
  const unknownHashes: string[] = [];
  for (const raw of q.hashes) {
    const hash = String(raw || '').toLowerCase();
    if (!hash) continue;
    if (config.debrid.rdLedger.enabled && rdLedger.peek(hash) !== 'unknown') continue;
    unknownHashes.push(hash);
  }

  // Só chamada com credencial EFETIVA vai à rede: uma fonte sem token/key da
  // fonte nem apiKey da instalação enviaria `Bearer ` vazio (StremThru) ou um
  // segmento `realdebrid=` sem valor (Torrentio) a terceiros — ruído e pior,
  // vazamento de intenção sem resposta. O `available()` já guarda essa porta
  // para o flag do `current()`; aqui fechamos o mesmo buraco para chamadas
  // diretas a `check()`.
  const enabledSources = sources.filter((source) => {
    if (source.name === 'stremthru') {
      return Boolean(config.debrid.rdOracle.stremthruUrl)
        && Boolean(config.debrid.rdOracle.stremthruToken || apiKey);
    }
    if (source.name === 'torrentio') {
      return Boolean(config.debrid.rdOracle.torrentio)
        && Boolean(config.debrid.rdOracle.torrentioKey || apiKey);
    }
    return false;
  });

  if (enabledSources.length === 0 || unknownHashes.length === 0) {
    metrics.observe('debrid.rd.oracle.ms', Date.now() - started);
    return new Map();
  }

  const netQuery: OracleQuery = { ...q, hashes: unknownHashes, deadlineAt };
  const results = await Promise.allSettled(
    enabledSources.map((source) => source.check(netQuery, apiKey)),
  );

  // Fusão: true de qualquer fonte vence; false só se autoritativo.
  const merged = new Map<string, boolean>();
  let hits = 0;
  for (const result of results) {
    if (result.status !== 'fulfilled') {
      metrics.count('debrid.rd.oracle.fail');
      continue;
    }
    for (const [hash, cached] of result.value) {
      if (cached) {
        if (!merged.get(hash)) hits += 1;
        merged.set(hash, true);
      } else if (!merged.has(hash)) {
        // false autoritativo: a fonte enumerou e disse que não está cacheado.
        merged.set(hash, false);
      }
      // Se já tínhamos true de outra fonte, não sobrescreve com false.
    }
  }

  metrics.count('debrid.rd.oracle.hits', hits);
  metrics.observe('debrid.rd.oracle.ms', Date.now() - started);
  return merged;
}
