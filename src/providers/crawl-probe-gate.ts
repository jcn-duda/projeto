// Gate da SONDA por site (Fase 8). Um site novo só entra na rotação do motor
// depois de uma AMOSTRA de páginas (módulo puro `crawl-site-probe.ts`, executado
// pela CLI): o veredito fica no `crawl_state` do próprio site, sob
// `PROBE_STATE_KEY`.
//
// ESTE MÓDULO NÃO TEM PARSER PRÓPRIO: o codec é o da sonda
// (`parseProbeVerdict`/`renderProbeVerdict`), importado daqui. Um segundo
// parser aceitaria um veredito velho, forjado ou de outro site — exatamente o
// que o gate existe para impedir. Toda leitura é quiet e falha FECHADA:
// chave ausente, JSON quebrado, engine fechada, `site` diferente, versão
// diferente, amostra incompleta ou `stop` que não seja "amostra completa"
// significam "sem GO" (e, com o gate exigido, site barrado).
import {
  PROBE_SAMPLE,
  PROBE_STATE_KEY,
  PROBE_VERDICT_VERSION,
  parseProbeVerdict,
  type ProbeCounts,
  type ProbeRates,
  type ParsedProbeVerdict,
} from './crawl-site-probe.js';
import type { CrawlEngine } from '../utils/crawl-store.js';

export { PROBE_STATE_KEY };

/** Veredito que AUTORIZA o site a raspar. O codec da sonda é minúsculo. */
export const PROBE_GO = 'go';

/** Motivo pelo qual um site não foi liberado (o painel mostra; ninguém adivinha). */
export type ProbeBlockReason = 'sem-veredito' | 'veredito-de-outro-site' | 'versao' | 'amostra-incompleta' | 'parcial' | 'sem-go';

export interface ProbeGate {
  /** O gate está exigido (global `requireProbe`)? */
  required: boolean;
  /** Veredito gravado pela sonda (`go`/`no-go`/`inconclusive`); `null` = nunca rodou. */
  verdict: string | null;
  /** O site pode entrar na rotação? `true` quando o gate não é exigido. */
  ok: boolean;
  at: number | null;
  /** Tamanho da amostra que produziu o veredito. */
  sample: number | null;
  /** Por que não liberou (`null` quando liberou ou o gate não é exigido). */
  blockedBy: ProbeBlockReason | null;
  /**
   * Taxas (0..1, exceto `magnetsPerPage`) do veredito gravado, para o card do
   * painel mostrar o que a sonda mediu. `null` = não há veredito deste site
   * (nunca rodou, ou o que existe é de outro site/outra versão — medida alheia
   * não aparece como se fosse deste site).
   */
  rates: ProbeRates | null;
  /** Contagens do veredito gravado, com a mesma regra de ausência de `rates`. */
  counts: ProbeCounts | null;
  /** Códigos curtos e estáveis que derrubaram a sonda (vazio = sem ressalva). */
  reasons: string[];
}

/** Veredito de um site, já validado contra o site que o motor está servindo. */
export interface SiteVerdict {
  verdict: ParsedProbeVerdict;
  ok: boolean;
  blockedBy: ProbeBlockReason | null;
  /**
   * As MEDIDAS do veredito são deste site e desta versão do codec. Um veredito
   * de outro site (ou gravado por um codec velho) pode explicar a não
   * liberação, mas os números dele não descrevem este site — e o painel só os
   * exibe quando isto é verdadeiro.
   */
  measured: boolean;
}

/**
 * Valida o veredito gravado contra o site que o motor quer servir.
 * Todas as travas são de FECHO-FECHADO: só `go`, da versão vigente, do MESMO
 * site, com a amostra inteira (40) e parada por amostra completa liberam.
 */
export function verdictFor(siteId: string, raw: string | null | undefined): SiteVerdict | null {
  const parsed = parseProbeVerdict(raw);
  if (!parsed) return null;
  const verdict = String(parsed.verdict || '');
  const fail = (blockedBy: ProbeBlockReason): SiteVerdict => ({ verdict: parsed, ok: false, blockedBy, measured: false });
  if (parsed.site !== siteId) return fail('veredito-de-outro-site');
  // Daqui para frente o veredito É deste site: as medidas dele descrevem este
  // site, mesmo que ainda não liberem (GO com amostra incompleta é assim).
  const measured = parsed.v === PROBE_VERDICT_VERSION;
  const base = { verdict: parsed, measured };
  if (!measured) return { ...base, ok: false, blockedBy: 'versao' };
  if (parsed.sample !== PROBE_SAMPLE) return { ...base, ok: false, blockedBy: 'amostra-incompleta' };
  if (parsed.stop !== 'amostra-completa') return { ...base, ok: false, blockedBy: 'parcial' };
  if (verdict !== PROBE_GO) return { ...base, ok: false, blockedBy: 'sem-go' };
  return { ...base, ok: true, blockedBy: null };
}

/** Lê e valida o veredito do site. `null` engine = crawl.db fechado = sem GO. */
export function readVerdict(engine: CrawlEngine | null, siteId: string): SiteVerdict | null {
  if (!engine) return null;
  try {
    return verdictFor(siteId, engine.getState(siteId, PROBE_STATE_KEY));
  } catch {
    // `getState` é leitura best-effort: um banco travado não pode parar o
    // motor inteiro — o site fica barrado, que é a falha segura.
    return null;
  }
}

/** Decide o gate. `required=false` ⇒ sempre liberado (compat com antes da Fase 8). */
export function probeGateOpen(required: boolean, found: SiteVerdict | null): boolean {
  if (!required) return true;
  return found?.ok === true;
}

/** Gate + foto para o status. */
export function probeGate(required: boolean, found: SiteVerdict | null): ProbeGate {
  // `blockedBy` é o motivo de NÃO liberar, então ele só existe quando o site
  // não liberou. Com um GO válido o `?? 'sem-veredito'` antigo mentia: o card
  // dizia "liberado" (`ok:true`) e "sonda nunca rodou" na mesma frase, porque
  // o veredito válido tem `blockedBy === null` por contrato.
  const liberou = probeGateOpen(required, found);
  // As MEDIDAS vêm do veredito gravado (é delas que o painel tira as taxas e os
  // motivos), e só quando elas descrevem ESTE site: ausente = `null`, nunca
  // zero — 0% afirmaria que a sonda mediu e reprovou.
  const medido = found?.measured === true ? found.verdict : null;
  return {
    required,
    verdict: found?.verdict.verdict ?? null,
    ok: liberou,
    at: found?.verdict.at ?? null,
    sample: found?.verdict.sample ?? null,
    blockedBy: liberou ? null : (found?.blockedBy ?? 'sem-veredito'),
    rates: medido ? { ...medido.rates } : null,
    counts: medido ? { ...medido.counts } : null,
    reasons: medido ? [...medido.reasons] : [],
  };
}
