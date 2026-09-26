import type { ResolvedHref, ResolverLink } from './types.js';
import type { EpisodeStep } from './release-rules.js';

// Máquina de estados da âncora, extraída de release-rules.ts pela catraca de
// 400 linhas (o arquivo irmão ficaria em 399 com o contrato skip-sem-advance).
// release-rules.ts reexporta `createLinkCollector`/`LinkCollectorConfig`, então
// os perfis continuam importando de lá — nenhum caminho de consumo mudou.

/** Configuração da máquina de estados da âncora (`createLinkCollector`). */
export interface LinkCollectorConfig {
  anchorRe: RegExp;
  resolveHref(match: RegExpExecArray, html: string, baseUrl: string | undefined): ResolvedHref;
  anchorTextOf(match: RegExpExecArray): string;
  stripTags(value: string): string;
  /** `null` significa "sem áudio conhecido" até um marcador aparecer (vaca). */
  initialAudio: string | null;
  audioFromSegment(segment: string): string | null;
  audioFromAnchor?: ((anchorText: string) => string | null) | null;
  episodeStep: EpisodeStep;
  qualityFn(context: string): number | null;
  sourceFn(context: string): string | null;
  decodeHtml?: ((html: string) => string) | null;
  extrasOf?: ((options: Record<string, unknown>) => Record<string, unknown>) | null;
}

/**
 * Máquina de estados da âncora, comum aos seis perfis: percorre o post EM
 * ORDEM DE DOCUMENTO mantendo o estado da seção corrente (áudio do cabeçalho
 * e episódio do segmento) e extrai cada botão. O perfil aporta regex de
 * âncora, resolução de href (magnet direto vs protetor), texto da âncora,
 * classificadores de áudio, passo de episódio e de qualidade/fonte.
 * `resolveHref` devolve `{ url }` ou `{ skip: true, advance? }` — `advance`
 * diz se o cursor da seção avança mesmo descartando o botão (comando/vaca
 * avançam em falha de URL/rejeição; bludv/nerd/tdf nunca avançam),
 * preservando exatamente o corte do segmento de cada perfil. Skip SEM
 * `advance` é a âncora não-download preservada: o cursor fica parado (o
 * contexto dela segue no segmento do próximo botão emitido) e o passo de
 * episódio roda normalmente — atualiza o estado sem emitir item.
 */
function createLinkCollector(cfg: LinkCollectorConfig) {
  const {
    anchorRe, resolveHref, anchorTextOf, stripTags, initialAudio,
    audioFromSegment, audioFromAnchor, episodeStep, qualityFn, sourceFn,
    decodeHtml = null, extrasOf = null,
  } = cfg;
  const SIZE_RE = /([\d.,]+)\s*(TB|GB|MB|KB)\b/g;

  return function parseDownloadLinks(
    html: string | null | undefined,
    baseUrl?: string,
    options: Record<string, unknown> = {},
  ): ResolverLink[] {
    const links: ResolverLink[] = [];
    // `html` nulo/indefinido é fronteira de parser (harness de boundary manda
    // null): normaliza para '' antes do decode — o decodeHtml do perfil já
    // aceitava null e devolvia ''.
    const source = decodeHtml ? decodeHtml(html ?? '') : String(html ?? '');
    let audio: string | null = initialAudio;
    let currentEpisode: number | null = null;
    let cursor = 0;
    // Clone por chamada: /g carrega lastIndex e um throw no meio do laço
    // deixaria o cursor sujo para a chamada seguinte.
    const anchor = new RegExp(anchorRe.source, anchorRe.flags);
    let match: RegExpExecArray | null;
    while ((match = anchor.exec(source))) {
      const resolved = resolveHref(match, source, baseUrl);
      if (resolved.skip) {
        if (resolved.advance) {
          cursor = anchor.lastIndex;
        } else {
          // Contrato skip-sem-advance (âncora não-download preservada — ex.:
          // "Veja Online" da página por-episódio do vaca): o cursor NÃO avança —
          // o contexto anterior do bloco (ss-ep-num/título) continua no segmento
          // do próximo botão de download — e o passo de episódio roda como se a
          // âncora fosse transparente: atualiza o estado, nunca emite item.
          // O episódio é pista AUXILIAR aqui: um throw no passo (o matchAll
          // TypeError do packMatchAll cru /i de comando/vaca é comportamento
          // vivo preservado no caminho de item emitido) NÃO pode abortar o
          // parse da página inteira por causa de uma âncora que não emite
          // nada. Em erro o estado anterior vale — o botão seguinte herda o
          // episódio de antes, como se a âncora transparente não existisse.
          try {
            const segment = stripTags(source.slice(cursor, match.index)).toUpperCase();
            const anchorText = anchorTextOf(match).toUpperCase();
            currentEpisode = episodeStep(segment, anchorText, currentEpisode).state;
          } catch {
            // Estado anterior preservado; o caminho de item emitido continua
            // SEM try — throw lá é contratado e sobe.
          }
        }
        continue;
      }

      const segment = stripTags(source.slice(cursor, match.index)).toUpperCase();
      const anchorText = anchorTextOf(match).toUpperCase();
      cursor = anchor.lastIndex;

      // 1. Áudio: o marcador do segmento atualiza o estado (vale para os
      // botões seguintes até a próxima seção); o da âncora é local ao botão.
      const segAudio = audioFromSegment(segment);
      if (segAudio) audio = segAudio;
      const localAudio = audioFromAnchor ? audioFromAnchor(anchorText) : null;

      // 2. Episódio vs reset de pack (escopo definido pelo perfil).
      const step = episodeStep(segment, anchorText, currentEpisode);
      currentEpisode = step.state;

      // 3. Qualidade, fonte e tamanho do contexto (segmento + âncora).
      const context = `${segment} ${anchorText}`;
      const sizeHit = [...context.matchAll(SIZE_RE)].pop();
      const item: ResolverLink = {
        url: resolved.url,
        quality: qualityFn(context),
        size: sizeHit ? `${sizeHit[1]} ${sizeHit[2]}` : null,
        audio: localAudio != null ? localAudio : audio,
        episode: step.episode,
        source: sourceFn(context),
      };
      if (extrasOf) Object.assign(item, extrasOf(options));
      links.push(item);
    }
    return links;
  };
}

export { createLinkCollector };
