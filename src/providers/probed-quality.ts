import type { RawItem } from '../../types/domain.js';
import debrid from '../debrid/index.js';
import { opts } from '../runtime.js';
import { extractInfoHash, isMultiWorkCollection, qualityFromTitle, UNKNOWN_QUALITY } from '../utils/format.js';
import { peekFileSizes } from '../debrid/file-sizes.js';
import { pickFile, baseName } from '../debrid/file-selector.js';
import { peekVideoQuality, scheduleVideoProbe } from '../debrid/video-quality.js';
import * as metrics from '../utils/metrics.js';

type WorkHintInput = { n: string[]; y: number | null } | null | undefined;

// Medições novas por build: o resto entra nas buscas seguintes.
const MAX_PROBES_PER_BUILD = 2;

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
  const adapterId = debrid.current()?.id || '';
  let apiKey = '';
  try {
    apiKey = opts().debridApiKey || '';
  } catch {
    apiKey = '';
  }
  let scheduled = 0;
  return items.map((item) => {
    if (!item || item.provenQuality) return item;
    const title = String(item.title || item.Title || '');
    if (qualityFromTitle(title) !== UNKNOWN_QUALITY) return item;
    const hash = String(extractInfoHash(item.infoHash || item.magnet || '') || '').toLowerCase();
    const files = hash ? peekFileSizes(hash) : null;
    if (!files) return item;
    let file: { path?: string; size?: number; link?: string } | null = null;
    try {
      file = season != null && episode != null
        ? pickFile(files, { season, episode })
        : pickFile(files, workHint?.n?.length
          ? { work: { names: workHint.n, year: workHint.y, pack: isMultiWorkCollection(title) } }
          : {});
    } catch {
      return item;
    }
    if (!file?.path) return item;
    const fromName = qualityFromTitle(baseName(file.path));
    if (fromName !== UNKNOWN_QUALITY) {
      metrics.count('search.quality.fileName');
      return { ...item, provenQuality: fromName };
    }
    const measured = peekVideoQuality(hash, file.path);
    if (measured) {
      metrics.count('search.quality.probed');
      return { ...item, provenQuality: measured };
    }
    if (measured === undefined && adapterId === 'alldebrid' && apiKey && scheduled < MAX_PROBES_PER_BUILD) {
      const queuedNow = scheduleVideoProbe({
        hash,
        path: file.path,
        link: String(file.link || ''),
        apiKey,
        size: Number(file.size) || 0,
      });
      if (queuedNow) scheduled += 1;
    }
    return item;
  });
}

export { applyProbedQuality };
