// Coluna estreita do Stremio (nome do stream). Extraído de `search-names.ts`
// pela catraca de 400 linhas; a fábrica (`toStremioStream`) segue lá.
import config from '../config.js';
import { opts } from '../runtime.js';
import { UNKNOWN_QUALITY, compactAudio, compactTracker, looksPtBr } from './audio-quality.js';

interface StreamDisplayOptions {
  title?: string;
  quality?: string;
  audio?: string;
  source?: string;
  edition?: string;
  tracker?: string;
  isBr?: boolean;
  seeders?: number;
  /** Item de reserva do banco (Etapa 4): dispara o selo 📦/~. */
  fromFallback?: boolean;
  style?: string;
  showSource?: boolean;
}

/**
 * `name` ocupa a coluna estreita do Stremio: marca + qualidade, como Torrentio.
 * A release completa fica em `title`, na coluna larga de detalhes.
 *
 * A release já foi duplicada aqui por causa de cliente que renderiza SÓ o
 * `name`. O preço apareceu na tela: com o título inteiro mais o prefixo do
 * debrid, a coluna estreita quebrava em uma palavra por linha e CADA stream
 * ocupava ~11 linhas de altura — cabiam três na tela inteira.
 *
 * `STREAM_NAME_STYLE=full` devolve o comportamento antigo para quem depende de
 * um cliente que ignora o `title`.
 */
function streamDisplayName({
  title = '',
  quality,
  audio,
  source,
  edition,
  tracker,
  isBr = false,
  seeders = 0,
  fromFallback = false,
  style,
  showSource,
}: StreamDisplayOptions = {}) {
  let userOpts: { streamNameStyle?: string; streamNameShowSource?: boolean } | null = null;
  try { userOpts = opts(); } catch {}
  const effectiveStyle = style || userOpts?.streamNameStyle || config.streamNameStyle;
  const effectiveShowSource = showSource !== undefined
    ? showSource
    : (userOpts?.streamNameShowSource !== undefined ? userOpts.streamNameShowSource : config.streamNameShowSource);

  // A ordem é a da decisão: resolução, corte do filme, origem. Sem corte e
  // fonte, quatro releases 4K do mesmo filme saíam idênticas.
  //
  // Chip DUAL só com prova PT (isBr ou looksPtBr): Dual Audio YTS sem PT segue
  // Dual por dentro, mas o rótulo não pode parecer dublado BR (8.12).
  const dualHasPtProof = isBr || looksPtBr(title);
  const audioChip = audio === 'Dual' && !dualHasPtProof ? '' : compactAudio(audio);
  const details = [
    quality === UNKNOWN_QUALITY ? null : quality === '2160p' ? '4K' : quality,
    edition || null,
    source || null,
    audioChip || null,
    isBr ? 'BR' : null,
  ].filter(Boolean).join(' ');
  // Fallback (Etapa 4): seeders é foto do acervo, não medição viva — `~` avisa.
  const stats = [
    details,
    effectiveShowSource ? compactTracker(tracker) : null,
    fromFallback ? (Number(seeders) > 0 ? `👤 ~${seeders}` : '👤 ~') : (Number(seeders) > 0 ? `👤 ${seeders}` : null),
  ].filter(Boolean).join(' · ');
  const statsWithFallback = fromFallback ? `📦 · ${stats}` : stats;

  // Sem o nome do addon: o cliente já o exibe no badge do card.
  if (effectiveStyle === 'full') return [title, statsWithFallback].filter(Boolean).join('\n');
  // Release sem resolução/corte/fonte/áudio não tem o que resumir: o título vale mais.
  return details ? statsWithFallback : [title, statsWithFallback].filter(Boolean).join('\n');
}

export { streamDisplayName };
export type { StreamDisplayOptions };
