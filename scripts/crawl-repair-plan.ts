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
//       1. dn declara: complete/multi-temporada → RAIZ (-1,-1); 1 temporada +
//          1 episódio → {S,E}; 1 temporada sem episódio único → pack {S,-1}.
//       2. só dn SILENCIOSO cai no título, com as MESMAS saídas — e o
//          EPISÓDIO ÚNICO do título é PRESERVADO {S,E}: sem dn não há prova
//          de pack, e rebaixar (S,E)→(S,-1) virava falso move (19 linhas
//          medidas 2026-09-27). (A régua de CAPTURA em modo batch devolve
//          episode=null porque a página não tem episódio; no reparo a linha
//          armazenada É a prova de que a release nasceu por-episódio.)
//     O executor decide mover vs. fundir conforme a PK destino já existir.
//   - `sanitize-title`: título do magnet carrega `E01` FICTÍCIO — prova: o dn
//     declara pack/faixa SEM episódio único e o título declara exatamente UM.
//     Sem dn não há prova e nada é tocado.
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
 * Remove o episódio FICTÍCIO do título. Prova exigida: o dn declara
 * temporada/pack SEM episódio único (é o pack que o construtor antigo
 * titulou com o `E01` herdado do bloco `ss-ep-num`). O número removido é o
 * da linha armazenada quando ela declara episódio; sem esse, o token `E01`/
 * `Episódio 01` do próprio título. Marcador colado em `SxxEyy` não é
 * tocado (não há fronteira de palavra). Devolve null sem prova ou sem mudança.
 */
export function sanitizeFakeEpisodeTitle(title: string, dn: string, storedEpisode: number): string | null {
  if (!dn || !title) return null;
  const fromDn = parseTitleSeasonEpisode(dn);
  if (fromDn.seasons.length === 0 || fromDn.episodes.length === 1) return null;
  const token = /\be0?(\d{1,3})\b/i.exec(title) || /\bepis[oó]dio\s*0?(\d{1,3})/i.exec(title);
  const ep = storedEpisode >= 0 ? storedEpisode : (token ? Number(token[1]) : null);
  if (ep == null || !Number.isFinite(ep) || ep <= 0 || ep > 999) return null;
  const cleaned = String(title)
    .replace(new RegExp(`(?:^|[\\s._-])e0?${ep}(?=$|[\\s._-])`, 'gi'), ' ')
    .replace(new RegExp(`(?:^|[\\s._-])epis[oó]dio\\s*0?${ep}(?=$|[\\s._-])`, 'gi'), ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned && cleaned !== title.trim() ? cleaned : null;
}

/**
 * Alvo declarado pela evidência DECODIFICADA (título × dn), precedência
 * ESTRITA do dn: ele é o nome REAL do torrent (conteúdo) e vence o título do
 * post sempre que declara — não "quando é mais específico". Pack de UMA
 * temporada → {S,-1}; série inteira/faixa/multi → RAIZ; EPISÓDIO ÚNICO →
 * {S,E}, inclusive vindo do título quando o dn é silencioso (preserva a
 * locação por-episódio; ver cabeçalho). `null` = nada declara: a linha fica
 * onde está.
 */
function declaredTarget(title: string, dn: string): { season: number; episode: number } | null {
  const fromDn = dn.trim() ? parseTitleSeasonEpisode(dn) : null;
  if (fromDn && (fromDn.complete || fromDn.seasons.length > 0)) {
    if (fromDn.complete || fromDn.seasons.length > 1) return { season: -1, episode: -1 };
    return {
      season: fromDn.seasons[0],
      episode: fromDn.episodes.length === 1 ? fromDn.episodes[0] : -1,
    };
  }
  const fromTitle = parseTitleSeasonEpisode(title);
  if (fromTitle.complete || fromTitle.seasons.length > 1) return { season: -1, episode: -1 };
  if (fromTitle.seasons.length !== 1) return null;
  return { season: fromTitle.seasons[0], episode: fromTitle.episodes.length === 1 ? fromTitle.episodes[0] : -1 };
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
    if (clean) actions.push({ kind: 'sanitize-title', row, from: row.title, to: clean });
  }
  return { actions, kept };
}
