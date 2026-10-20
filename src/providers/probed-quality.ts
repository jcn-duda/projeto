import type { RawItem } from '../../types/domain.js';
import debrid from '../debrid/index.js';
import { opts } from '../runtime.js';
import { extractInfoHash, isMultiWorkCollection, qualityFromTitle, UNKNOWN_QUALITY } from '../utils/format.js';
import { peekFileSizes } from '../debrid/file-sizes.js';
import { pickFile, baseName } from '../debrid/file-selector.js';
import { peekVideoQuality, scheduleVideoProbe } from '../debrid/video-quality.js';
import * as metrics from '../utils/metrics.js';
import * as frozen from '../utils/stream-frozen.js';

type WorkHintInput = { n: string[]; y: number | null } | null | undefined;

/** Escopo da obra: o mesmo hint que o build usa para escolher o arquivo. */
type ProofScope = {
  season?: number | null;
  episode?: number | null;
  workHint?: WorkHintInput;
  /** Título do release: só o flag de multiobra da dica `w` sai dele. */
  title?: string;
};

// Medições novas por build: o resto entra nas buscas seguintes.
const MAX_PROBES_PER_BUILD = 2;

/**
 * Arquivo que o play tocaria (`pickFile` sobre o memo `fsz`). `null` = o hash
 * não tem lista, ou a lista é ambígua sem dica de obra/episódio.
 */
function pickProvenFile(
  files: NonNullable<ReturnType<typeof peekFileSizes>>,
  scope: ProofScope,
) {
  try {
    if (scope.season != null && scope.episode != null) {
      return pickFile(files, { season: scope.season, episode: scope.episode });
    }
    return pickFile(files, scope.workHint?.n?.length
      ? { work: { names: scope.workHint.n, year: scope.workHint.y, pack: isMultiWorkCollection(String(scope.title || '')) } }
      : {});
  } catch {
    return null;
  }
}

/**
 * Resolução PROVADA do arquivo: primeiro o nome (fato publicado), depois a
 * medição do cabeçalho já feita (`vres`, 30 dias). `null` = sem prova.
 */
function qualityOfFile(hash: string, file: { path?: string }) {
  if (!file?.path) return null;
  const fromName = qualityFromTitle(baseName(file.path));
  if (fromName !== UNKNOWN_QUALITY) return { quality: fromName, source: 'name' as const };
  const measured = peekVideoQuality(hash, file.path);
  return measured ? { quality: measured, source: 'probe' as const } : null;
}

/** Hash normalizado do item (o mesmo de `applyFileEvidence`). */
function hashOfItem(item: RawItem): string {
  return String(extractInfoHash(item?.infoHash || item?.magnet || '') || '').toLowerCase();
}

function yearOf(value: number | string | null | undefined): number | null {
  const year = Number(value);
  return Number.isFinite(year) && year > 0 ? year : null;
}

/**
 * Prova de qualidade para o consumidor NATIVO (`/internal/search/index` e
 * `/internal/search/collect`): o item sai com `provenQuality` — o campo que o
 * `RawItem` do Rust já lê (`map_stream` usa antes do título) e que decide o
 * balde de qualidade do `limit_reserving_br`.
 *
 * Sem a prova, o índice manda o release com o rótulo do POST ("sem resolução")
 * e o corte nativo perde a vaga BR que o Node mantém (Interestelar: BR `f320`
 * trocado por 4K global, medido em 2026-10-20). A fonte é a MESMA do build:
 * `fsz` + `pickFile` + nome/medição do arquivo — nada é inventado e nenhuma
 * sonda nova é agendada aqui (agendar é do build do Node, não da rota).
 */
function stampProvenQuality(
  items: RawItem[],
  scope: { season?: number | null; episode?: number | null; names?: string[]; year?: number | string | null } = {},
): RawItem[] {
  const workHint: WorkHintInput = scope.names && scope.names.length > 0
    ? { n: scope.names, y: yearOf(scope.year) }
    : null;
  let stamped = 0;
  const out = items.map((item) => {
    if (!item || item.provenQuality) return item;
    const title = String(item.title || item.Title || '');
    if (qualityFromTitle(title) !== UNKNOWN_QUALITY) return item;
    const hash = hashOfItem(item);
    const files = hash ? peekFileSizes(hash) : null;
    if (!files) return item;
    const file = pickProvenFile(files, {
      season: scope.season,
      episode: scope.episode,
      workHint,
      title,
    });
    const proof = file ? qualityOfFile(hash, file) : null;
    if (!proof) return item;
    stamped += 1;
    return { ...item, provenQuality: proof.quality };
  });
  if (stamped) metrics.count('search.proof.stamped', stamped);
  // Captura congelada: grava a prova quando a ROTA roda dentro de uma captura
  // (`frozenDir` no contexto). O caminho normal de shadow não herda o dir da
  // 2ª request — quem grava o mapa nesse caso é o `applyProbedQuality` do build
  // do Node; aqui é a rede de segurança para o caminho index-served.
  frozen.recordProvenQualities(out);
  return out;
}

/**
 * Resolução do ARQUIVO que o play tocaria, para o release cujo título não diz
 * 720p/1080p ("FILMOGRAFIA COMPLETA JORNADA NAS ESTRELAS-STAR TREK-PTBR").
 * Entra como `provenQuality` ANTES do `toStremioStream`, pelo mesmo caminho da
 * evidência de arquivo: o nome, o `_quality`, o filtro de resolução e as cotas
 * nascem certos — corrigir depois arrumaria só o rótulo.
 *
 * Em ordem: o nome do arquivo escolhido, e senão a medição do cabeçalho
 * (`debrid/video-quality.ts`). Sem medição ainda, agenda uma em fundo e o item
 * segue como está. Precisa da lista de arquivos do hash (`fsz`): sem ela não
 * há arquivo escolhido e nada muda.
 */
function applyProbedQuality(
  items: RawItem[],
  { season, episode, workHint }: { season?: number | null; episode?: number | null; workHint?: WorkHintInput } = {},
): RawItem[] {
  const adapter = debrid.current();
  const adapterId = adapter?.id || '';
  let apiKey = '';
  try {
    apiKey = opts().debridApiKey || '';
  } catch {
    apiKey = '';
  }
  let scheduled = 0;
  const out = items.map((item) => {
    if (!item || item.provenQuality) return item;
    const title = String(item.title || item.Title || '');
    if (qualityFromTitle(title) !== UNKNOWN_QUALITY) return item;
    const hash = hashOfItem(item);
    const files = hash ? peekFileSizes(hash) : null;
    if (!files) return item;
    const file = pickProvenFile(files, { season, episode, workHint, title });
    if (!file?.path) return item;
    const proof = qualityOfFile(hash, file);
    if (proof) {
      metrics.count(proof.source === 'name' ? 'search.quality.fileName' : 'search.quality.probed');
      return { ...item, provenQuality: proof.quality };
    }
    // Premiumize entrega o link direto do arquivo (`fileLink`); a AllDebrid
    // destrava o link da lista pelo `/link/unlock` dentro da medição.
    const fileLink = adapterId === 'alldebrid' ? null : adapter?.fileLink;
    if (peekVideoQuality(hash, file.path) === undefined
      && (adapterId === 'alldebrid' || fileLink) && apiKey && scheduled < MAX_PROBES_PER_BUILD) {
      const path = file.path;
      const queuedNow = scheduleVideoProbe({
        hash,
        path,
        link: String(file.link || ''),
        apiKey,
        size: Number(file.size) || 0,
        ...(fileLink ? { resolveUrl: () => fileLink(apiKey, hash, path) } : {}),
      });
      if (queuedNow) scheduled += 1;
    }
    return item;
  });
  // Gate congelado: `out` é o lote que o build REALMENTE usa — a prova do
  // `releaseIndex` (que passou por aqui) mais a sonda acima. Grava hash →
  // qualidade porque o índice/lote gravado antes disso não a carrega.
  frozen.recordProvenQualities(out);
  return out;
}

export { applyProbedQuality, stampProvenQuality };
