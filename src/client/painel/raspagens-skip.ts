// VOCABULÁRIO ÚNICO dos "tick pulado" (Fase 4.3). O motor (sidecar Rust) pausa
// e adia cada site por motivos próprios — pausado, auto-pausa, teto-horario,
// usuario-ativo, parser-pendente, ingest-pendente, sem-fila — e o painel Node
// exclui site pela config (desabilitado, sonda). Antes cada canto traduzia do
// seu jeito (skipText, siteStateLabel, badges) e o card não explicava POR QUE
// o site não anda. Aqui os dois lados viram um mapa só, com rótulo curto e o
// porquê, e a composição (siteWhyIdle) decide o que se aplica.
//
// Motivo desconhecido cai no próprio id: rótulo desconhecido é melhor que
// rótulo inventado (mesma régua do blockedText). `skipText` de
// `raspagens-site.ts` delega aqui — não crie um segundo mapa.
import type { CrawlSiteCard, CrawlSummary } from './raspagens-model.js';

export interface SkipVocabEntry {
  /** Rótulo curto (a linha do card). */
  label: string;
  /** O porquê, no vocabulário do operador. */
  hint: string;
}

export const SKIP_VOCAB: Record<string, SkipVocabEntry> = {
  // --- do motor (sidecar Rust / log do tick) ---
  pausado: { label: 'pausado', hint: 'pausa manual do operador' },
  'auto-pausa': { label: 'pausa automática', hint: 'streak de erros ou canário de layout; retome no card' },
  'teto-horario': { label: 'teto horário', hint: 'o balde de requisições da hora encheu; volta na próxima janela' },
  'usuario-ativo': { label: 'usuário ativo', hint: 'o app está em uso; a raspagem só roda com o app ocioso' },
  'parser-pendente': { label: 'parser pendente', hint: 'página lida sem parser montado; aguarda o motor' },
  'ingest-pendente': { label: 'ingestão pendente', hint: 'resultado lido aguardando gravação no acervo' },
  'sem-fila': { label: 'sem fila', hint: 'não há página pendente para este site agora' },
  // --- derivados no painel Node (config/rotação) ---
  desabilitado: { label: 'desligado', hint: 'fora da rotação pela config (global ou do site)' },
  probe: { label: 'sem GO da sonda', hint: 'a sonda não liberou o site' },
  'sem-adaptador': { label: 'sem adaptador', hint: 'nenhum adaptador nesta rodada' },
  'sem-trabalho': { label: 'sem trabalho pendente', hint: 'fila vazia e cursor em dia' },
  // --- esperas do /status do sidecar (holds) ---
  'em-espera': { label: 'em espera', hint: 'o site pediu espera (ex.: Retry-After de 429); o card mostra até quando' },
};

/** Rótulo do motivo; id desconhecido vira o próprio id (fail-open). */
export function skipLabel(id: string | null | undefined): string {
  const text = String(id || '').trim();
  if (!text) return '';
  return SKIP_VOCAB[text]?.label ?? text;
}

/** O porquê do motivo; sem tradução (id desconhecido) devolve vazio — o
 * rótulo já aparece com o id cru, e hint inventado seria mentira. */
export function skipHint(id: string | null | undefined): string {
  const text = String(id || '').trim();
  if (!text) return '';
  return SKIP_VOCAB[text]?.hint ?? '';
}

/** Um motivo com o texto pronto para o card. */
export interface SkipReasonView {
  id: string;
  label: string;
  hint: string;
}

function reason(id: string): SkipReasonView {
  return { id, label: skipLabel(id), hint: skipHint(id) };
}

/**
 * POR QUE o site não anda agora, na ordem de autoridade (a mesma do
 * `siteStateLabel`): a exclusão da rotação vence tudo, depois pausa global
 * vence estado do site, depois os freios do motor. Site ativo e sem freio
 * devolve vazio — "não anda" tem que ser verdade, não rótulo de getDefault.
 *
 * `holdUntilMs` é o "em espera até" do /status do sidecar (epoch ms vigente;
 * `null` = sem hold). O teto-horário é DERIVADO do balde GLOBAL do summary
 * (`pagesThisHour >= maxPerHour`) enquanto o site é o ativo — o card não
 * carrega balde por site; o sidecar pode confirmar depois, e o id é o mesmo.
 */
export function siteWhyIdle(
  card: CrawlSiteCard,
  summary: CrawlSummary,
  holdUntilMs: number | null,
): SkipReasonView[] {
  // 1) Exclusão da rotação (config/sonda) — o site não é nem candidato.
  if (card.probe.out === 'desligado') return [reason('desabilitado')];
  if (card.probe.out === 'sem-go') return [reason('probe')];
  const ids: string[] = [];
  const push = (id: string): void => {
    if (!ids.includes(id)) ids.push(id);
  };
  // 2) Pausas: automática vence a manual (mesma ordem do motorBadge).
  if (card.active && summary.autoPause) push('auto-pausa');
  if (card.paused) push('pausado');
  if (card.active && summary.paused && !card.paused) push('pausado');
  // 3) Espera pedida pelo site (hold do sidecar) — independe de pausa.
  if (holdUntilMs != null) push('em-espera');
  // 4) Teto horário: freio GLOBAL do motor — o card não carrega balde por
  //    site, então o sinal honesto é o balde do summary cheio enquanto este
  //    site é o ativo (fora da vez, ele não é quem consome o balde).
  if (card.active && summary.maxPerHour > 0 && summary.pagesThisHour >= summary.maxPerHour) push('teto-horario');
  // 5) skipReason do motor (quando o payload o trouxer): traduz com o MESMO
  //    vocabulário; motivo já listado não repete.
  if (card.probe.skip) push(card.probe.skip);
  return ids.map(reason);
}

/** Linha pronta para o card: "teto horário — o balde de requisições da hora
 * encheu…"; sem motivo, vazio (a linha some). */
export function whyIdleText(reasons: SkipReasonView[]): string {
  return reasons
    .map((r) => (r.hint ? `${r.label} — ${r.hint}` : r.label))
    .join(' · ');
}
