// Planejador PURO da remediação de locações de série (Fase 7, bug 2026-09-27
// v2). Extraído do `crawl-repair-series-locations.ts` para caber na catraca de
// linhas e para o plano ser testável sem banco: entra a lista de linhas
// `magnet_work × magnet`, sai a lista de ações IDEMpotentes.
//
// Ações (na ordem de execução do CLI):
//   - `delete-identity`: contaminação de identidade — release "Live Action"
//     de outra adaptação gravada sob a série (One Piece 2023/2026 sob o anime
//     tt0388629). EXCLUIR, nunca remanejar: o imdbId certo é prova positiva,
//     que a remediação não tem. Só dispara com o ano de estreia da obra
//     (`--premiere=tt…:AAAA`); sem ano, vira `suspect-identity` (relatório,
//     nada grava — ausência de dado nunca autoriza remoção).
//   - `move`: a locação declarada difere da armazenada — vale para a raiz E
//     para temporada errada (TWD: packs gravados em S1/S5 em vez de S4).
//     RÉGUA com precedência ESTRITA do dn (é CONTEÚDO; o título é página),
//     sobre evidência DECODIFICADA (`decodeEvidence`: "4ordf"/"4ª" e
//     entidades cruas antes do parse):
//       1. dn declara: complete/FAIXA de temporadas explícita/múltiplas
//          temporadas EXPLICITAMENTE marcadas → RAIZ (-1,-1); 1 temporada +
//          1 episódio → {S,E} (até 4 dígitos: One Piece E1000+); 1 temporada
//          sem episódio único (ou faixa de episódios) → pack {S,-1}.
//       2. só dn SILENCIOSO cai no título, com as MESMAS saídas — e o
//          EPISÓDIO ÚNICO do título é PRESERVADO {S,E}: sem dn não há prova
//          de pack, e rebaixar (S,E)→(S,-1) virava falso move (19 linhas
//          medidas 2026-09-27). (A régua de CAPTURA em modo batch devolve
//          episode=null porque a página não tem episódio; no reparo a linha
//          armazenada É a prova de que a release nasceu por-episódio.)
//     A decisão de RAIZ usa um SCANNER ESTRICTO LOCAL (`strictSeasonScan`),
//     não o parser compartilhado: `parseTitleSeasonEpisode` é PERMISSIVO de
//     propósito no matching (o filtro revalida a obra na leitura), e ali o
//     ruído "DS4K"/"BS8"/"Chris44"/"1280x720"/"2x2" vira temporada falsa —
//     raiz FALSA no reparo (medido no dry-run 2026-09-27). O scanner só
//     aceita token com fronteira real: `s04` precedido de letra (DS4K, BS8,
//     Chris44) ou seguido de letra/dígito (4K) NÃO é temporada.
//   - `sanitize-title`: título do magnet carrega `E01` FICTÍCIO SOLTO —
//     prova: o dn declara pack/faixa SEM episódio único E o título contém
//     EXATAMENTE UM marcador SOLTO (`E`/`EP`/`Episódio` em fronteira;
//     `SxxEyy` colado NUNCA é saneado — é a declaração do próprio título,
//     mesmo quando o episódio é herdado), o token é removido DE FATO e a
//     mudança não é só whitespace. O número vem do token do TÍTULO; o
//     stored é só fallback seguro (diverge → não toca).
//
// Idempotência: linha já na locação certa não gera ação; título já saneado
// não muda; linha excluída não existe na segunda passada.
import { parseTitleSeasonEpisode } from '../src/utils/episode-matching.js';
import { decodeEvidence } from '../src/providers/crawl-sites/vaca-series-locate.js';
import { liveActionYearContradicts } from '../src/utils/matching-tokens.js';

export interface RepairRow {
  hash: string;
  imdb: string;
  season: number;
  episode: number;
  firstSeen: number;
  lastSeen: number;
  passedFilter: number;
  title: string;
  uri: string;
}

export type RepairAction =
  | { kind: 'delete-identity'; row: RepairRow }
  | { kind: 'suspect-identity'; row: RepairRow }
  | { kind: 'move'; row: RepairRow; to: { season: number; episode: number } }
  | { kind: 'sanitize-title'; row: RepairRow; from: string; to: string };

/** dn= do magnet decodificado (percent + espaço), '' quando ausente. */
export function dnOf(uri: string): string {
  const m = /[?&]dn=([^&]+)/.exec(String(uri || ''));
  if (!m) return '';
  try { return decodeURIComponent(m[1].replace(/\+/g, ' ')); } catch { return m[1]; }
}

/**
 * Remove o episódio FICTÍCIO do título. Prova exigida, TODAS juntas:
 *   1. o dn declara temporada/pack SEM episódio único (é o pack que o
 *      construtor antigo titulou com o `E01` herdado do bloco `ss-ep-num`);
 *   2. o título contém EXATAMENTE UM marcador SOLTO (`E`/`EP`/`Episódio`
 *      em fronteira de palavra) — `SxxEyy` colado NUNCA é saneado: é a
 *      declaração do próprio título (episódio real ou herdado), e ranges
 *      ("S04E01-E08", "E01-E08") e listas ("e04.e05") têm vários → NADA é
 *      tocado;
 *   3. o marcador não faz parte de range ("E01-E08");
 *   4. o número vem do token do TÍTULO; o stored é fallback SEGURO: se
 *      diverge do token, é inconsistência e nada é tocado;
 *   5. o token é removido DE FATO e a mudança não é só whitespace
 *      (normalizar espaços nunca foi saneamento).
 * Devolve null sem prova ou sem mudança real.
 */
export function sanitizeFakeEpisodeTitle(title: string, dn: string, storedEpisode: number): string | null {
  if (!dn || !title) return null;
  const fromDn = parseTitleSeasonEpisode(dn);
  if (fromDn.seasons.length === 0 || fromDn.episodes.length === 1) return null;
  const raw = String(title);
  // EXATAMENTE UM marcador — e SÓ marcador SOLTO (E/EP/Episódio em fronteira):
  // `SxxEyy` colado É a declaração do próprio título (episódio real ou
  // fictício herdado), e remover o "Eyy" de "S02E05" destruiria o token que
  // o filtro/pickFile usam — título com marcador colado NUNCA é saneado
  // (medido: stored 5/2/-1 e dn episódio → todos null).
  const markers = [...raw.matchAll(/(?<![a-z0-9])(?:e\d{1,4}(?![a-z0-9])|epis[oó]dio\s?\d{1,4})/gi)];
  if (markers.length !== 1) return null;
  const marker = markers[0][0];
  // O marcador não pode ser a ponta de um range/lista — mesmo COLADO em
  // temporada ("S04E01-08", medido no dry-run real: removia o E01 e deixava
  // o "-08" órfão). Segundo número não pode ter letra/dígito depois, para
  // não confundir com "E01 1080p"; espaço também é separador de lista
  // ("e01 08" dos packs MIRCrew) — falso bloqueio é conservador, dano não.
  if (/e\d{1,4}(?:\s*[-–,.]|\s+)\s*(?:e\s?)?\d{1,4}(?![a-z0-9])/i.test(raw)) return null;
  const epNum = /(\d{1,4})/.exec(marker)?.[1];
  const ep = Number(epNum);
  if (!Number.isFinite(ep) || ep <= 0 || ep > 9999) return null;
  // Fallback SEGURO: stored divergente do token é inconsistência — não toca.
  if (storedEpisode >= 0 && storedEpisode !== ep) return null;
  // Remoção na POSIÇÃO do marcador (não na primeira ocorrência do texto).
  const at = markers[0].index ?? raw.indexOf(marker);
  const cleaned = `${raw.slice(0, at)} ${raw.slice(at + marker.length)}`.replace(/\s+/g, ' ').trim();
  // Mudança só de whitespace NÃO é saneamento (caso medido: títulos "Arc …"
  // que o regex antigo "saneava" colapsando espaços).
  if (!cleaned || cleaned.replace(/\s+/g, '') === raw.replace(/\s+/g, '')) return null;
  return cleaned;
}

interface StrictScan {
  seasons: Set<number>;
  episodes: Set<number>;
  /** Faixa de TEMPORADAS explícita ("S01-S15", "S01-6", "S1-12E1", "1ª a 15ª"). */
  rangeSeasons: boolean;
  /** Faixa de EPISÓDIOS ("E01-E08", "S2E1-8") — pack, não episódio único. */
  rangeEpisodes: boolean;
  complete: boolean;
}

const EP = String.raw`\d{1,4}`;

/**
 * Scanner ESTRICTO de temporada/episódio para a decisão de RAIZ do reparo
 * (motivo no cabeçalho). Só token com fronteira REAL declara temporada:
 *   - `s04`/`season 4`/`temporada 4`/`4ª temporada`, exigindo que não haja
 *     letra/dígito ANTES do token ("DS4K", "BS8", "Chris44" NÃO são) nem
 *     letra/dígito DEPOIS do número ("4K" não é);
 *   - faixas explícitas de temporadas e o marcador de série completa;
 *   - episódios via `SxxEyy` (até 4 dígitos) e faixas `E01-E08`/`E1-8`.
 */
function strictSeasonScan(text: string): StrictScan {
  const raw = String(text || '');
  const seasons = new Set<number>();
  const episodes = new Set<number>();
  let rangeSeasons = false;
  let rangeEpisodes = false;
  const complete = /(?:todas?\s+(?:as\s+)?temporadas|serie\s+completa|temporadas\s+completas)/i.test(raw);
  // Faixa de temporadas explícita.
  if (/(?<![a-z0-9])s\d{1,2}\s*[-–—]\s*s?\d{1,2}(?![a-z0-9e])/i.test(raw)
    || /(?<![a-z0-9])s\d{2}-\d{1,2}(?![a-z0-9])/i.test(raw)
    || /(?<![a-z0-9])s\d{1,2}-\d{1,2}e\d/i.test(raw)
    || /(?<!\d)\d{1,2}\s*[ªº°]?\s*(?:a|ate|to)\s*\d{1,2}\s*[ªº°]?\s*\.?\s*temporadas?/i.test(raw)) {
    rangeSeasons = true;
  }
  // Pares SxxEyy (4 dígitos) e faixas de episódio.
  for (const m of raw.matchAll(new RegExp(`(?<![a-z0-9])s(\\d{1,2})\\s?e(${EP})(?![a-z0-9])`, 'gi'))) {
    seasons.add(Number(m[1]));
    episodes.add(Number(m[2]));
  }
  if (new RegExp(`(?<![a-z0-9])e${EP}\\s*[-–]\\s*(?:e\\s?)?${EP}(?![a-z0-9])`, 'i').test(raw)
    || new RegExp(`s\\d{1,2}\\s?e${EP}\\s*[-–]\\s*(?:e\\s?)?${EP}(?![\\dp])`, 'i').test(raw)) rangeEpisodes = true;
  // Tokens soltos ESTRITOS de temporada (a fronteira é o conserto do ruído).
  for (const m of raw.matchAll(/(?<![a-z0-9])s(\d{1,2})(?![a-z0-9])/gi)) seasons.add(Number(m[1]));
  for (const m of raw.matchAll(/(?:season|temporada)\s*[.]?\s*(\d{1,2})(?!\d)/gi)) seasons.add(Number(m[1]));
  for (const m of raw.matchAll(/(?<![a-z0-9])(\d{1,2})\s*[ªº°]?\s*[.]?\s*temporada/gi)) seasons.add(Number(m[1]));
  return { seasons, episodes, rangeSeasons, rangeEpisodes, complete };
}

/**
 * Alvo declarado pela evidência DECODIFICADA (título × dn), precedência
 * ESTRITA do dn: ele é o nome REAL do torrent (conteúdo) e vence o título do
 * post sempre que declara. RAIZ só com declaração EXPLÍCITA: complete, faixa
 * de temporadas ou ≥2 temporadas marcadas de fato (scanner estrito — ruído
 * "DS4K"/"BS8"/"V2"/"1280x720"/"2x2" NÃO cria multi-temporada; "Reacher
 * S01.S02 Complete" e "S01-6 S01-S06" continuam raiz legítima). 1 temporada:
 * episódio único (4 dígitos) → {S,E}; faixa de episódios/pack → {S,-1};
 * dn silencioso → título, com as MESMAS saídas (episódio único do título é
 * PRESERVADO; ver cabeçalho). `null` = nada declara: a linha fica onde está.
 */
function declaredTarget(title: string, dn: string): { season: number; episode: number } | null {
  const fromDn = dn.trim() ? strictSeasonScan(dn) : null;
  if (fromDn && (fromDn.complete || fromDn.rangeSeasons || fromDn.seasons.size > 0)) {
    return targetOfScan(fromDn);
  }
  return targetOfScan(strictSeasonScan(title));
}

function targetOfScan(scan: StrictScan): { season: number; episode: number } | null {
  const root = scan.complete || scan.rangeSeasons || scan.seasons.size > 1;
  if (root) return { season: -1, episode: -1 };
  if (scan.seasons.size !== 1) return null;
  const episode = !scan.rangeEpisodes && scan.episodes.size === 1 ? [...scan.episodes][0] : -1;
  return { season: [...scan.seasons][0], episode };
}

export interface RepairPlanOptions {
  /** Ano de estreia por imdb (`--premiere=tt…:AAAA`); ausente = sem veto. */
  premieres?: Map<string, number>;
}

export interface RepairPlan {
  actions: RepairAction[];
  /** Linhas avaliadas e deixadas como estão (raiz legítima / locação certa). */
  kept: number;
}

export function planRepairs(rows: readonly RepairRow[], opts: RepairPlanOptions = {}): RepairPlan {
  const actions: RepairAction[] = [];
  const sanitized = new Set<string>();
  let kept = 0;
  for (const row of rows) {
    // Evidência DECODIFICADA (título E dn): entidades destruídas ("4ordf")
    // e cruas ("4&ordf;") antes de qualquer parse/veto — sem isso o TWD
    // declara temporada nenhuma e o card/página impõe a dele.
    const dn = decodeEvidence(dnOf(row.uri));
    const title = decodeEvidence(String(row.title || ''));
    const evidence = `${title} ${dn}`.trim();
    const premiere = opts.premieres?.get(row.imdb);
    if (/\blive[\s.-]?action\b/i.test(evidence)) {
      if (premiere == null) {
        actions.push({ kind: 'suspect-identity', row });
        continue; // sem ano de estreia não há condenação — só relatório
      }
      if (liveActionYearContradicts(evidence, premiere)) {
        actions.push({ kind: 'delete-identity', row });
        continue;
      }
    }
    const target = declaredTarget(title, dn);
    if (target && (target.season !== row.season || target.episode !== row.episode)) {
      actions.push({ kind: 'move', row, to: target });
    } else {
      kept += 1;
    }
    // Saneamento: a PROVA (pack sem episódio único) usa o dn decodificado;
    // a REMOÇÃO do token opera sobre o título CRU (é o texto gravado —
    // `E01` não é entidade, e o UPDATE idempotente casa o título visto).
    const clean = sanitizeFakeEpisodeTitle(String(row.title || ''), dn, row.episode);
    // UMA ação de saneamento por hash×título-novo: a mesma hash com duas
    // linhas de obra repetia a ação idêntica no relatório (e o UPDATE era
    // no-op na segunda) — ações distintas, contagem honesta.
    const key = `${row.hash}|${clean}`;
    if (clean && !sanitized.has(key)) {
      sanitized.add(key);
      actions.push({ kind: 'sanitize-title', row, from: row.title, to: clean });
    }
  }
  return { actions, kept };
}
