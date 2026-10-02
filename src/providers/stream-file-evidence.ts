// Correção do stream pela evidência de ARQUIVO (o que o play viu dentro do
// torrent). Extraído de `stream-builder-pipeline.ts` pelo orçamento de 400
// linhas; roda antes do sortAndLimit, como antes.
import type { RawItem } from '../../types/domain.js';
import * as releaseIndex from '../utils/release-index.js';
import { extractInfoHash } from '../utils/format.js';
import { UNKNOWN_QUALITY } from '../utils/audio-quality.js';
import * as metrics from '../utils/metrics.js';

/**
 * Corrige o stream com o que os ARQUIVOS provaram (áudio e resolução reais,
 * gravados pelo play/tail em `releaseIndex`). Roda ANTES do sortAndLimit de
 * propósito: `_dubbed` decide o preferDubbed/brFirst e `_quality` decide o
 * filtro de resolução e as cotas — corrigir depois arrumaria só o rótulo.
 *
 * O título do post é palpite; o nome do arquivo é fato. Medido no True
 * Detective S03: duas fontes RedeTorrent com rótulo idêntico "1080p BR", uma
 * inglesa ("H264-METCON") e uma dublada ("DUAL"), com a inglesa por cima; e o
 * dublado anunciado como 1080p sendo um arquivo 720p — filtrar 1080p escondia
 * justamente o dublado, porque nesta temporada o dublado só existe em 720p.
 *
 * Só corrige o que foi PROVADO: sem evidência o stream passa intacto.
 */
export function applyFileEvidence(items: RawItem[]) {
  let corrigidos = 0;
  const out = items.map((item) => {
    const hash = String(extractInfoHash(item?.infoHash || item?.magnet || '') || '').toLowerCase();
    if (!hash) return item;
    const ev = releaseIndex.fileEvidence(hash);
    if (!ev) return item;
    corrigidos += 1;
    return {
      ...item,
      // Rótulo vazio com prova de release EN também é veredito: força o
      // stream a NÃO passar por dublado (o `_br` do indexer o empatava).
      ...(ev.a || ev.e ? { provenAudio: ev.a || '', provenName: ev.n || '' } : {}),
      ...(ev.q && ev.q !== UNKNOWN_QUALITY ? { provenQuality: ev.q } : {}),
    };
  });
  if (corrigidos) metrics.count('search.file.corrected', corrigidos);
  return out;
}
