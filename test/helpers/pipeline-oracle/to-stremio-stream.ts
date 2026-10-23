// Movido de src/utils/search-names.ts na fase 1: sem chamador em produção desde o corte do
// /stream (F4.4); vive só para o oráculo congelado e os testes dele.
import type { RawItem, Stream } from '../../../types/domain.js';
import { extractInfoHash, decodeEntities, bytesToSize, magnetDisplayName } from '../../../src/utils/title-normalization.js';
import { isMultiWorkCollection } from '../../../src/utils/release-matching.js';
import { UNKNOWN_QUALITY, qualityFromTitle, sourceFromTitle, audioFromTitle, editionFromTitle, explicitPtAudio, looksPtBr, stripQualityTagBlob } from '../../../src/utils/audio-quality.js';
import { dnContradictsDubClaim, enSceneMirrorTitle, foreignLangNamedForBucket } from '../../../src/utils/audio-cleanup.js';
import { streamDisplayName } from './stream-display.js';
import { TRACKERS } from '../../../src/utils/search-names.js';

const UNKNOWN_SIZE_MAX = 1024;

// Teto de sanidade, do outro lado da mesma moeda. A definição Cardigann do
// redetorrent carimba 1.784.881.034.035 bytes (1,62 TB) em 53 das 93 releases
// de uma busca — valor fabricado, não medido. Exibi-lo é mentir para o
// usuário, e pior: com filtro de tamanho ligado ele apagava a fonte dublada
// inteira. Nem remux 4K de temporada completa chega perto de 500 GB.
const IMPLAUSIBLE_SIZE_MIN = 500 * 1024 ** 3;

/**
 * Normaliza resultados de Jackett/Prowlarr/demo para o formato do Stremio.
 *
 * É a FÁBRICA do que chega ao cliente: o tipo de retorno faz o typecheck cobrar
 * aqui a união do `Stream` (todo item precisa de ação — `url`, `infoHash`,
 * `externalUrl` ou a marca `notice`), na origem e não na tela. Devolve `null`
 * quando o item não tem infoHash extraível — não há o que tocar.
 */
function toStremioStream(item: RawItem): Stream | null {
  const infoHash = extractInfoHash(item.infoHash || item.magnet || item.MagnetUri || item.Guid);
  if (!infoHash) return null;

  const title = decodeEntities(item.title || item.Title || 'Torrent');
  // O blob do HDRTorrent descreve TODAS as opções do post, não esta release.
  // O classificador já o ignora, mas expô-lo em `title` faz clientes que
  // derivam o selo por conta própria encontrarem 2160p num botão 1080p/720p.
  const displayTitle = stripQualityTagBlob(title);
  // Origem BR pelo indexer E pelo título: tracker global também hospeda
  // dublado titulado em português, e é o título que denuncia. O flag muda o
  // chip BR, as vagas reservadas e a priorização de dublado.
  const titlePt = Boolean(item.ptTitleDual) || looksPtBr(title);
  // Agregador BR republica magnet gringo com o nome de cena intacto ("Barbie
  // (2023) 1080p WEBRip [YTS.MX]", "…-NTb[TGx]"): o flag do indexer dava vaga
  // BR a release EN. Só o flag do provider cede, e só com prova contrária —
  // grupo de cena EN no título e nenhum sinal PT. Medido no magnets.db
  // (2026-09-24): 42 de 1.353 BR-só-pelo-indexer, todos EN.
  const isBr = titlePt || (Boolean(item.isBr) && !enSceneMirrorTitle(title));
  const seeders = Number(item.seeders ?? item.Seeders ?? 0) || 0;
  const rawSize = Number(item.size ?? item.Size);
  // Os indexers BR mandam 1 KB quando o post não publica tamanho: o Jackett
  // descarta release sem tamanho, então o sentinela é o preço de não perder a
  // release. Aqui ele volta a ser "desconhecido" — nenhum vídeo tem 1 KB.
  const knownSize =
    Number.isFinite(rawSize) && rawSize > UNKNOWN_SIZE_MAX && rawSize < IMPLAUSIBLE_SIZE_MIN
      ? rawSize
      : 0;
  const size = bytesToSize(knownSize);
  const tracker = item.tracker || item.Tracker || item.Indexer || item.indexer || '';
  // Prova pelo ARQUIVO tem precedência sobre o título do post: o nome do
  // arquivo é fato, o título é palpite — e mente sobre áudio e resolução.
  // Quem grava é o play/tail via releaseIndex; aqui só consumimos o campo.
  const quality = item.provenQuality || qualityFromTitle(title);
  // O dn= do magnet preserva o nome REAL do release quando o título do post
  // esconde a gravação ("Resident Evil (2026) [1080p 2.60 GB]" com dn
  // "…CAMRip…"). Fonte lida no dn é evidência do arquivo, não do WordPress.
  // Quando o magnet revela CAM (gravação) e o título não diz nada, o magnet
  // vence: é a prova do arquivo real, não o palpite do post.
  const magnetDn = magnetDisplayName(item);
  const titleSource = sourceFromTitle(title);
  const magnetSource = sourceFromTitle(magnetDn);
  // Fallback do índice: raw sem magnet (só infoHash) carrega mediaSource gravado.
  const indexedSource = typeof item.mediaSource === 'string' ? item.mediaSource : '';
  const source = (magnetSource === 'CAM' && titleSource !== 'CAM')
    ? (magnetSource || titleSource)
    : (titleSource || magnetSource || indexedSource);
  // excludeCam/notCam leem `_magnetDn`; sem magnet, sintético mínimo pra CAM do índice.
  const magnetDnOut = magnetDn || (source === 'CAM' ? 'CAMRip' : '');
  // Prova VAZIA (release EN sem marca PT no arquivo) é veredito sobre DUBLADO,
  // não sobre o rótulo. Quando o título já diz "Legendado" ele CONCORDA com a
  // prova — apagá-lo trocava "720p WEB-DL LEG BR" por "720p WEB-DL BR" e
  // escondia do usuário a única informação de áudio que existia. Rótulo que
  // afirma dublado continua sendo derrubado pela prova, que é o motivo dela
  // existir. `_dubClaim` = promessa do post; `_dubbed` = só prova positiva.
  const provenAudio = item.provenAudio;
  const titleAudio = audioFromTitle(title);
  const audio = provenAudio !== undefined
    ? provenAudio || (titleAudio === 'Legendado' ? 'Legendado' : '')
    : titleAudio;
  const isDubLabel = (a: string) => a === 'Dublado' || a === 'Dual' || a === 'Nacional';
  // Claim pelo TÍTULO (mesma regra que o antigo `_dubbed`), sem fileEvidence.
  // `brOriginOnly` nunca claim: origem não prova áudio.
  const titleClaim = item.brOriginOnly
    ? false
    : isBr
      ? isDubLabel(titleAudio)
      : explicitPtAudio(title);
  // Prova POSITIVA só: provenAudio Dual/Dublado/Nacional, ou provenName com PT.
  const positiveProof = provenAudio !== undefined
    ? isDubLabel(provenAudio)
    : Boolean(item.provenName && explicitPtAudio(item.provenName));
  // Evidência que NÃO é dublado ('' = EN, 'Legendado', …) anula o claim; sem
  // prova de arquivo, o `dn=` de cena EN do próprio torrent também anula.
  const claimContradicted = provenAudio !== undefined
    ? !isDubLabel(provenAudio)
    : dnContradictsDubClaim(magnetDn);
  // O banco guarda CLASSIFICAÇÃO de áudio da captura, não prova medida: texto
  // do post (título/dn=) dizendo Legendado ou nomeando idioma estrangeiro veta
  // a marca — PT explícito (DUBLADO/PT-BR…) absorve SÓ a menção estrangeira;
  // LEGENDADO no dn= vale pelo PARSER (DUAL+LEGENDADO é dual, não veta).
  const hasExplicitPtText = explicitPtAudio(title) || explicitPtAudio(magnetDn);
  const bankAudioContradicted = titleAudio === 'Legendado'
    || audioFromTitle(magnetDn) === 'Legendado'
    || (!hasExplicitPtText && (foreignLangNamedForBucket(title) || foreignLangNamedForBucket(magnetDn)));
  // Chip DUB/DUAL/NAC só com prova — claim lista sob d:1 sem parecer confiável.
  const audioForChip = positiveProof ? audio : (isDubLabel(audio) ? '' : audio);
  const edition = editionFromTitle(title);

  // Convenção do Torrentio: 👤 seeders, 💾 tamanho, ⚙️ indexer. Os clientes
  // (Stremio e Power Movie) reconhecem esses marcadores e montam a linha de
  // metadados a partir deles — com "•" eles não exibiam seeds nem a fonte.
  // Fallback do banco (Etapa 4): 📦 identifica a reserva e o seeders vira `~N`
  // (foto do acervo, não medição viva) — sem mentir o valor de `_seeders`.
  // A foto do índice na resposta instantânea (`fromSnapshot`) exibe o MESMO selo:
  // para quem olha a lista, idx e banco são igualmente dado salvo. Só o
  // `fromFallback` carrega as exclusões (autofetch, índice, banco).
  const fromFallback = Boolean(item.fromFallback);
  const stored = fromFallback || Boolean(item.fromSnapshot);
  const seederBit = stored
    ? (seeders > 0 ? `👤 ~${seeders}` : '👤 ~')
    : `👤 ${seeders}`;
  const bits = [
    ...(stored ? ['📦'] : []),
    seederBit,
    size ? `💾 ${size}` : null,
    tracker ? `⚙️ ${tracker}` : null,
  ].filter(Boolean);

  return {
    // A coluna esquerda precisa ficar curta. O título bruto nesta posição fazia
    // o Stremio quebrar uma palavra por linha em telas estreitas.
    name: streamDisplayName({
      title: displayTitle,
      quality,
      audio: audioForChip,
      source,
      edition,
      tracker,
      isBr,
      seeders,
      fromFallback: stored,
    }),
    title: `${displayTitle}\n${bits.join(' ')}`,
    infoHash,
    sources: TRACKERS.map((t) => `tracker:${t}`),
    behaviorHints: {
      // Binge de uma release sem resolução não pode cair no grupo do SD.
      bingeGroup: `powerm-${quality === UNKNOWN_QUALITY ? 'na' : quality}-${source || 'any'}`,
    },
    _seeders: seeders,
    _quality: quality,
    // 0 = desconhecido, e o filtro de tamanho máximo já trata 0 como "passa".
    _size: knownSize,
    // Total EXATO do torrent: o `_size` morre no sortAndLimit, e o dedupe de
    // pack × avulso (dedupe de pack do Rust, `annotateEpisodeSizes`) compara bytes depois da checagem.
    _bytes: knownSize,
    // Agregadores BR espelham magnets globais: DUAL sem PT explícito não pode
    // ganhar vaga, prioridade ou autofetch só porque o post foi marcado BR.
    // `_dubClaim` = promessa do título; `_dubbed` = só fileEvidence positivo.
    // Chip/preferDubbed/Chupim/adprot leem `_dubbed`; `dubbedOnly` aceita claim.
    //
    // Origem BR via `brOriginOnly` (inventário da conta, caso Zumbilândia)
    // marca `_br` para a vaga reservada e NUNCA claim/dubbed: origem ≠ áudio.
    _dubClaim: Boolean(titleClaim && !claimContradicted && !item.lied),
    _dubbed: Boolean(positiveProof && !item.lied),
    // Origem BR vem marcada pelo provider OU pelo título (dublado em tracker
    // global). Release de site BR sem marca nenhuma no título continua valendo
    // pelo flag do provider: comandotorrents/nerdfilmes não citam "DUBLADO".
    _br: isBr,
    // O label exibido não é estável o bastante para a prioridade, mas precisa
    // sobreviver ao merge para que o `name` do vencedor não perca a fonte.
    _tracker: tracker,
    // ID estável do indexer (não o label mutável) para o desempate de prioridade.
    _indexer: String(item.indexer || tracker || '').trim().toLowerCase(),
    // Pack multi-obra: vira `p:1` na dica assinada. TODO admitido é pack mesmo
    // quando só o `dn=` prova a coleção; o genérico (só título) segue idêntico.
    _multiWork: isMultiWorkCollection(title) || Boolean(item._multiWorkAdmitted), _multiWorkAdmitted: Boolean(item._multiWorkAdmitted),
      _lied: Boolean(item.lied),
      // Marca INTERNA do fallback (Etapa 4). Sobrevive ao limitReservingBr de
      // propósito, para o `finish` marcar a lista como parcial/fallback, e é
      // REMOVIDA antes do protocolo (applyNoticeOrigin).
      ...(fromFallback ? { _fromFallback: true } : {}),
      ...(fromFallback && item.fallbackFetchable ? { _fallbackFetchable: true } : {}),
      // Dublado que só o banco sabe (`_bankDub`): o classificador da captura
      // classificou o post como dublado mesmo sem o título citar áudio (Locke
      // & Key S01, 2026-10-08: pool BR do Chupim vazio com pack dubbed=1 à mão).
      // Mesmas guardas do claim — inclusive a origem da conta (origem ≠ áudio)
      // — mais a contradição de texto acima; exclusivo: com promessa do título,
      // o `_dubClaim` já basta.
      ...(fromFallback && isBr && item.dubbed && !item.brOriginOnly && !titleClaim
        && !claimContradicted && !bankAudioContradicted && !item.lied
        ? { _bankDub: true }
        : {}),
      ...(stored && !fromFallback ? { _fromSnapshot: true } : {}),
      // Campo INTERNO: dn= do magnet para o notCam do stream-ranking. O título
      // do post BR pode esconder TELESYNC/TS; o dn= revela. Removido na limpeza
      // final do stream-quotas antes do protocolo. CAM só no mediaSource do
      // índice → sintético 'CAMRip' (magnetDnOut) pra excludeCam continuar.
      _magnetDn: magnetDnOut,
  };
}

export { toStremioStream };
