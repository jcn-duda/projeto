/**
 * Modelo puro da aba Jev (runtime TypeSafe shadow).
 *
 * O bloco `typesafe` do backend agrega as DUAS perguntas shadow —
 * `audioClassify` (`is_ptbr_dub`, pergunta 1) e `dubLie` (`is_dub_lie`,
 * pergunta 2) — cada uma com a própria fila (contrato de `JudgmentCoreStatus`
 * em src/ai/judgment-queue-core.ts: 13 campos). O ORÇAMENTO e o BREAKER são
 * COMPARTILHADOS pelas duas (mesma chave/limite do provedor), então os campos
 * `hourly*`/`daily*`/`cooldownMs`/`consecutiveFail` chegam IGUAIS nos dois
 * blocos — o painel mostra esse bloco uma vez só. A
 * concordância NÃO vem no bloco: vem dos contadores `typesafe.shadow.*` do
 * snapshot de métricas, com labels FECHOS por lado de divergência.
 *
 * Leitura defensiva de ponta a ponta: campo ausente não quebra a aba — vira
 * zero/false. Nenhum campo além do contrato é lido.
 */

function asObject(value: unknown): Record<string, any> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, any>)
    : null;
}

/**
 * Labels FECHOS do lado da divergência por pergunta — espelham o `detLabels`
 * do spec de cada core (o motor grava `${shadowPrefix}.disagree.<label>`).
 * Prefixo desconhecido lê zero: nunca inventa chave de métrica.
 */
const SIDE_LABELS: Record<string, { ai: string; rule: string }> = {
  '': { ai: 'ai-pt', rule: 'rule-pt' },
  'dublie.': { ai: 'ai-lie', rule: 'rule-lie' },
};

export interface JevQuestionView {
  enabled: boolean;
  model: string;
  promptVersion: string;
  queueDepth: number;
  inFlight: number;
  paused: boolean;
  hourlyUsed: number;
  hourlyCap: number;
  dailyUsed: number;
  dailyCap: number;
  /** `cooldownRemainingMs` do contrato, já em ms. */
  cooldownMs: number;
  consecutiveFail: number;
  agree: number;
  disagree: number;
  /** Divergências em que a IA afirma o lado (ai-pt / ai-lie). */
  aiSide: number;
  /** Divergências em que a regra determinística afirma o lado. */
  ruleSide: number;
  /** agree / (agree + disagree); `null` quando não há julgamento algum. */
  agreementRate: number | null;
}

/**
 * View-model de UMA pergunta shadow. `q` é a fatia do bloco `typesafe`
 * (`audioClassify` ou `dubLie`); `counters` é o mapa `metrics.counters`;
 * `prefixo` é `''` (pergunta 1) ou `'dublie.'` (pergunta 2) — é o trecho entre
 * `typesafe.shadow.` e `agree`/`disagree` na chave da métrica.
 */
export function jevQuestionModel(q: unknown, counters: unknown, prefixo: string): JevQuestionView {
  const s = asObject(q) || {};
  const c = asObject(counters) || {};
  const base = 'typesafe.shadow.' + prefixo;
  const labels = SIDE_LABELS[prefixo] || { ai: '', rule: '' };
  const agree = Number(c[base + 'agree']) || 0;
  const disagree = Number(c[base + 'disagree']) || 0;
  const total = agree + disagree;
  return {
    enabled: Boolean(s.enabled),
    model: String(s.model || ''),
    promptVersion: String(s.promptVersion || ''),
    queueDepth: Number(s.queueDepth) || 0,
    inFlight: Number(s.inFlight) || 0,
    paused: Boolean(s.paused),
    hourlyUsed: Number(s.hourlyUsed) || 0,
    hourlyCap: Number(s.hourlyCap) || 0,
    dailyUsed: Number(s.dailyUsed) || 0,
    dailyCap: Number(s.dailyCap) || 0,
    cooldownMs: Number(s.cooldownRemainingMs) || 0,
    consecutiveFail: Number(s.consecutiveFail) || 0,
    agree,
    disagree,
    aiSide: labels.ai ? Number(c[base + 'disagree.' + labels.ai]) || 0 : 0,
    ruleSide: labels.rule ? Number(c[base + 'disagree.' + labels.rule]) || 0 : 0,
    agreementRate: total > 0 ? agree / total : null,
  };
}

export interface JevModel {
  enabled: boolean;
  model: string;
  audioClassify: JevQuestionView;
  dubLie: JevQuestionView;
  /** ETAPA C — overlay gateado: leitura cache-only no termo fraco. */
  overlay: JevOverlayView;
}

/** Bloco `typesafe.overlay` do status (ou os contadores `typesafe.overlay.*`). */
export interface JevOverlayView {
  enabled: boolean;
  /** Verdade operacional: flag ligada NÃO basta — portão fechado => false. */
  active: boolean;
  /** Motivo de bloqueio (enum FECHADO do backend; `''` quando ativo). */
  blockedReason: string;
  /** Leituras com a flag ON (toda chamada conta). */
  consulted: number;
  /** Leituras sem julgamento no cache (não derrubam nada). */
  cacheMiss: number;
  /** Derrubadas efetivas true->false no generic DUB isolado. */
  applied: number;
}

/** Rótulos PT do enum fechado `blockedReason` — nunca texto de credencial. */
const BLOCKED_LABEL: Record<string, string> = {
  'overlay-off': 'flag desligada',
  'runtime-off': 'runtime shadow desligado',
  'no-key': 'sem chave da API',
  'paused': 'Jev pausado',
  'model-alias': 'modelo não versionado (alias)',
};

/** Rótulo legível do motivo de bloqueio; motivo desconhecido não inventa texto. */
export function overlayBlockedLabel(reason: string): string {
  return BLOCKED_LABEL[reason] || '';
}

/** Leitura defensiva do overlay: bloco do status com fallback nos contadores. */
function jevOverlayModel(overlay: unknown, counters: Record<string, any>): JevOverlayView {
  const o = asObject(overlay) || {};
  const num = (campo: string, chave: string) => Number(o[campo] ?? counters['typesafe.overlay.' + chave]) || 0;
  return {
    enabled: Boolean(o.enabled),
    active: Boolean(o.active),
    blockedReason: String(o.blockedReason || ''),
    consulted: num('consulted', 'consulted'),
    cacheMiss: num('cacheMiss', 'cache-miss'),
    applied: num('applied', 'applied'),
  };
}

/** Contadores de métrica a partir do bloco `metrics` do status. */
function countersOf(metrics: unknown): Record<string, any> {
  return asObject(asObject(metrics)?.counters) || {};
}

/**
 * View-model da aba inteira. `typesafe` ausente (bloco velho, runtime desligado
 * antes do bloco existir) volta com o modelo vazio — a aba mostra INATIVO em
 * vez de quebrar.
 */
export function jevModel(typesafe: unknown, metrics: unknown): JevModel {
  const t = asObject(typesafe);
  const counters = countersOf(metrics);
  return {
    enabled: Boolean(t?.enabled),
    model: String(t?.model || ''),
    audioClassify: jevQuestionModel(t?.audioClassify, counters, ''),
    dubLie: jevQuestionModel(t?.dubLie, counters, 'dublie.'),
    overlay: jevOverlayModel(t?.overlay, counters),
  };
}

/** Uma linha do anel de discordâncias (ação `jev-disagreements`). */
export interface JevDisagreementView {
  at: number;
  side: string;
  n: number;
  dim: string;
  sample: string;
}

export interface JevDisagreementsModel {
  audioClassify: JevDisagreementView[];
  dubLie: JevDisagreementView[];
}

/**
 * Leitura defensiva de UMA lista do anel. A ordem devolvida é a de EXIBIÇÃO
 * (mais recente PRIMEIRO): o backend entrega em ordem de inserção com a mais
 * recente por último, então a lista é invertida aqui — o operador vê o caso
 * novo no topo. Payload velho/ausente vira lista vazia, nunca quebra.
 */
function disagreementList(raw: unknown): JevDisagreementView[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => {
      const e = asObject(entry) || {};
      return {
        at: Number(e.at) || 0,
        side: String(e.side || ''),
        n: Number(e.n) || 0,
        dim: String(e.dim || ''),
        sample: String(e.sample || ''),
      };
    })
    .reverse();
}

/** Resposta inteira da ação `jev-disagreements` → modelo da aba. */
export function jevDisagreementsModel(result: unknown): JevDisagreementsModel {
  const r = asObject(result);
  return {
    audioClassify: disagreementList(r?.audioClassify),
    dubLie: disagreementList(r?.dubLie),
  };
}
