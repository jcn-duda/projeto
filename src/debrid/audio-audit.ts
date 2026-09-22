import { dubbedLieVerdict, audioFromTitle, strongEnSceneMark, qualityFromTitle, UNKNOWN_QUALITY } from '../utils/format.js';
import { DubLieError, VIDEO_EXT, SAMPLE, isSiteAd, baseName } from './common.js';
import { looksMultiWorkFiles } from './file-selector.js';
import * as releaseIndex from '../utils/release-index.js';
import type { DebridFile } from './common.js';
import { recordFileSizes } from './file-sizes.js';
// Fachada ÚNICA de src/ai/ permitida fora dela (grafo travado por
// test/typesafe-shadow-graph.test.ts): a medição shadow da pergunta 2 mora na
// IA, mas o veredito que a alimenta nasce AQUI — e é só métrica.
import { enqueueDubLieJudgment } from '../ai/index.js';

/** Vídeos que são conteúdo: sem sample e sem a propaganda do site. */
function contentPaths(files: DebridFile[]) {
  return files
    .map((file) => ({ path: String(file.path || ''), size: Number(file.size) || 0 }))
    .filter((f) => VIDEO_EXT.test(f.path) && !SAMPLE.test(f.path) && !isSiteAd(f.path));
}

/**
 * O adaptador já recebeu estes arquivos para resolver o play; só então existe
 * prova suficiente para confrontar a promessa `_dubbed` da listagem.
 *
 * `shadow` (título do post + indexer de origem) liga a medição shadow da
 * pergunta 2 (`is_dub_lie`) com o veredito REAL desta função — os DOIS lados:
 * mentiu (throw abaixo) e honesto (retorno sem throw). Só o tail audit passa
 * o campo (o candidato é quem sabe a obra/indexer); o play interativo não
 * carrega título/indexer no hint assinado, então não mede. Fire-and-forget em
 * try/catch: qualquer falha da IA não pode afetar o play.
 */
function assertDubbedFiles(files: DebridFile[], promisedDubbed = false, shadow?: { title: string; indexer: string } | null) {
  if (!promisedDubbed) return;
  const paths = contentPaths(files).map((f) => f.path);
  const verdict = dubbedLieVerdict(paths, promisedDubbed);
  if (shadow?.title) {
    try {
      enqueueDubLieJudgment(shadow.title, shadow.indexer || '', paths, verdict.lie);
    } catch {
      // Fail-open: enfileiramento é observabilidade, nunca derruba o play.
    }
  }
  if (verdict.lie) {
    throw new DubLieError({
      matchedGroup: verdict.matchedGroup,
      videoCount: verdict.videoCount,
      sample: paths[0],
    });
  }
}

/**
 * Grava o que os ARQUIVOS provam — áudio e resolução reais. Roda no mesmo
 * ponto do assertDubbedFiles, com a listagem que o debrid acabou de entregar,
 * e vale para TODO play/tail: diferente da auditoria de mentira, aqui não há
 * promessa a confrontar, só fato a registrar.
 *
 * Existe porque o título do post não carrega essa informação e o rótulo da
 * lista engana: "BR" é a nacionalidade do INDEXER, não o áudio. Medido no
 * True Detective S03E03, duas fontes do RedeTorrent com rótulo idêntico
 * ("1080p BR"): uma é "…H264-METCON" (inglês), a outra "…DUAL" (dublada) — e a
 * inglesa ficava por cima. A resolução mente junto: o post anuncia 1080p e o
 * arquivo é 720p, então filtrar 1080p escondia justamente o dublado.
 *
 * Só grava o que é POSITIVO em alguma dimensão; ausência de marca não vira
 * veredito — 'en' exige grupo de cena reconhecido, não "faltou PT".
 */
function recordFileEvidence(infoHash: string, files: DebridFile[]) {
  if (!infoHash) return;
  // Ponto único por onde os cinco adapters passam a lista do torrent no play:
  // os tamanhos alimentam o tamanho do episódio na listagem de qualquer debrid.
  recordFileSizes(infoHash, files);
  const videos = contentPaths(files);
  if (videos.length === 0) return;
  const names = videos.map((f) => baseName(f.path));
  // A resolução vem do MAIOR vídeo: num pack, o arquivo dominante é o que
  // representa a release; num episódio solto, é o único.
  const maior = videos.reduce((a, b) => (b.size > a.size ? b : a));
  // Coleção de filmes não tem arquivo que represente a release: o maior é OUTRO
  // filme ("13 - Sem Fronteiras - 2016" gravado como prova do hash da
  // FILMOGRAFIA, 2026-09-14), e resolução/nome dele valeriam para todos. Nome
  // sem resolução também não é prova: gravar "sem resolução" sobrescrevia o
  // 1080p que o título do release anunciava.
  const multiWork = looksMultiWorkFiles(videos);
  const nameQuality = multiWork ? UNKNOWN_QUALITY : qualityFromTitle(baseName(maior.path));
  const quality = nameQuality !== UNKNOWN_QUALITY ? nameQuality : '';
  // O RÓTULO de áudio, não um veredito próprio: quem combina rótulo com origem
  // BR é o toStremioStream, com a regra já calibrada ("DUAL só vale como
  // dublado em site BR"). Um veredito paralelo aqui divergiria dela — e
  // divergiu: `DUAL`, que é como os sites BR nomeiam o dublado, não casa nos
  // marcadores PT do audit de mentira, e o dublado do S03E03 saía sem áudio.
  const audio = names.map((name) => audioFromTitle(name)).find(Boolean) || '';
  // Release de cena reconhecida é a prova NEGATIVA: mesmo sem rótulo de áudio,
  // "H264-METCON" não é dublado, e sem isso ele continuaria empatado com o
  // dublado no rótulo "BR" do indexer.
  const en = !audio && names.some((name) => Boolean(strongEnSceneMark(name)));
  if (!audio && !en && !quality) return;
  releaseIndex.markFileEvidence(infoHash, {
    a: audio,
    e: en ? 1 : 0,
    q: quality,
    n: multiWork ? '' : baseName(maior.path).slice(0, 80),
  });
}

export { assertDubbedFiles, recordFileEvidence };
