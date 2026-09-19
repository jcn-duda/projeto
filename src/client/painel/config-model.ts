// Modelo puro da configuração AO VIVO (Chupim/Colhedor). Traduz o payload de
// `autofetch-config-get` / `harvest-config-get` — snapshot com
// `{ effective, envDefaults, overriddenKeys, paused, pausedSince, schema }` —
// em linhas de formulário e no patch que pode ser enviado.
//
// Nenhum DOM, nenhum preact, nenhuma lista de campos hardcoded: o schema vindo
// do backend é a fonte única. Isso importa porque um knob novo nasce no
// servidor (`src/utils/*-live-schema.ts`) e o formulário do painel precisa
// crescer sozinho — hardcodar a lista criaria duas verdades que divergem em
// silêncio. O que existe fora do schema (drift, ou campo de controle como
// `paused`) continua aparecendo como linha sem metadado, nunca sumindo.
//
// "Preservar ausência" é invariante do módulo: valor faltante NÃO vira
// envDefault, NÃO vira 0 e NÃO vira false. `hasValue`/`hasEnvDefault` dizem o
// que o backend declarou; a view decide como exibir o vazio.

export type ConfigFieldType = 'boolean' | 'number';

/** Tipo da linha: `unknown` é o campo que apareceu em effective/envDefaults/
 * overriddenKeys mas o schema (ainda) não declara — não inventamos metadado. */
export type ConfigRowType = ConfigFieldType | 'unknown';

/** Espelho do `AutofetchSchemaField`/`HarvesterSchemaField` do backend. Só os
 * campos que o formulário consome; o `type` fica aberto para `unknown` porque
 * o payload é dinâmico. */
export interface ConfigSchemaField {
  key: string;
  label: string;
  type: ConfigRowType;
  group?: string;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  envDefault?: boolean | number;
  description?: string;
}

/** Snapshot do backend, já normalizado. `schema` pode vir vazio num payload
 * antigo — as linhas ainda são derivadas de effective/envDefaults/overridden. */
export interface ConfigSnapshot {
  effective: Record<string, unknown>;
  envDefaults: Record<string, unknown>;
  overriddenKeys: string[];
  paused?: boolean;
  pausedSince?: number | null;
  schema: ConfigSchemaField[];
}

/** Uma linha de formulário. `value`/`envDefault` são `undefined` quando o
 * backend não declarou o campo (o par `has*` é a autoridade da ausência). */
export interface ConfigRow {
  key: string;
  label: string;
  type: ConfigRowType;
  group: string | null;
  min: number | null;
  max: number | null;
  step: number | null;
  unit: string | null;
  description: string | null;
  value: unknown;
  hasValue: boolean;
  envDefault: unknown;
  hasEnvDefault: boolean;
  overridden: boolean;
  inSchema: boolean;
}

export interface ConfigGroup {
  group: string | null;
  rows: ConfigRow[];
}

export interface ConfigValidationError {
  key: string;
  label: string;
  /** `backend` = recusa autoritativa do servidor (`errors[]`), não da validação
   * local. A view trata igual; o valor separa a origem no diagnóstico. */
  reason: 'unknown-key' | 'type' | 'min' | 'max' | 'backend';
  message: string;
}

export interface ConfigValidationResult {
  ok: boolean;
  errors: ConfigValidationError[];
}

export interface ConfigDiff {
  patch: Record<string, unknown>;
  changedKeys: string[];
}

function asObject(value: unknown): Record<string, any> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, any>)
    : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Acepta o corpo inteiro (`{ ok, action, config: {...} }`) ou o snapshot
 * direto. Devolve null quando não há objeto algum. */
export function configSnapshot(payload: Record<string, any> | null | undefined): ConfigSnapshot | null {
  const root = asObject(payload);
  if (!root) return null;
  const inner = asObject(root.config) ?? root;
  if (!inner) return null;
  return {
    effective: asObject(inner.effective) ?? {},
    envDefaults: asObject(inner.envDefaults) ?? {},
    overriddenKeys: Array.isArray(inner.overriddenKeys) ? inner.overriddenKeys.map((k: unknown) => String(k)) : [],
    paused: typeof inner.paused === 'boolean' ? inner.paused : undefined,
    pausedSince: typeof inner.pausedSince === 'number' ? inner.pausedSince : null,
    schema: Array.isArray(inner.schema) ? (inner.schema as ConfigSchemaField[]) : [],
  };
}

function normalizeSchemaField(raw: any): ConfigSchemaField | null {
  const obj = asObject(raw);
  if (!obj) return null;
  const key = String(obj.key ?? '').trim();
  if (!key) return null;
  const field: ConfigSchemaField = {
    key,
    label: String(obj.label ?? key),
    type: obj.type === 'boolean' || obj.type === 'number' ? obj.type : 'unknown',
  };
  if (obj.group != null) field.group = String(obj.group);
  if (typeof obj.min === 'number') field.min = obj.min;
  if (typeof obj.max === 'number') field.max = obj.max;
  if (typeof obj.step === 'number') field.step = obj.step;
  if (obj.unit != null) field.unit = String(obj.unit);
  if (typeof obj.envDefault === 'boolean' || typeof obj.envDefault === 'number') field.envDefault = obj.envDefault;
  if (obj.description != null) field.description = String(obj.description);
  return field;
}

function rowFor(key: string, field: ConfigSchemaField | null, snapshot: ConfigSnapshot): ConfigRow {
  const hasValue = Object.prototype.hasOwnProperty.call(snapshot.effective, key)
    && snapshot.effective[key] !== undefined;
  const hasEnvDefault = Object.prototype.hasOwnProperty.call(snapshot.envDefaults, key)
    && snapshot.envDefaults[key] !== undefined;
  return {
    key,
    label: field?.label || key,
    type: field?.type || 'unknown',
    group: field?.group ?? null,
    min: numberOrNull(field?.min),
    max: numberOrNull(field?.max),
    step: numberOrNull(field?.step),
    unit: field?.unit ?? null,
    description: field?.description ?? null,
    value: hasValue ? snapshot.effective[key] : undefined,
    hasValue,
    envDefault: hasEnvDefault ? snapshot.envDefaults[key] : undefined,
    hasEnvDefault,
    overridden: snapshot.overriddenKeys.includes(key),
    inSchema: field != null,
  };
}

/** Linhas derivadas do snapshot. Ordem = ordem do schema; chaves que existem
 * só em overriddenKeys/effective/envDefaults entram depois, em ordem
 * alfabética estável (nunca são descartadas). */
export function configRowsFromSnapshot(snapshot: ConfigSnapshot | null): ConfigRow[] {
  if (!snapshot) return [];
  const schemaByKey = new Map<string, ConfigSchemaField>();
  const orderedKeys: string[] = [];
  for (const raw of snapshot.schema) {
    const field = normalizeSchemaField(raw);
    if (!field || schemaByKey.has(field.key)) continue;
    schemaByKey.set(field.key, field);
    orderedKeys.push(field.key);
  }

  const seen = new Set(orderedKeys);
  const extras: string[] = [];
  const consider = (keys: Iterable<string>) => {
    for (const key of keys) {
      if (typeof key !== 'string' || !key || seen.has(key)) continue;
      seen.add(key);
      extras.push(key);
    }
  };
  consider(snapshot.overriddenKeys);
  consider(Object.keys(snapshot.effective));
  consider(Object.keys(snapshot.envDefaults));
  extras.sort();

  return [...orderedKeys, ...extras].map((key) => rowFor(key, schemaByKey.get(key) ?? null, snapshot));
}

/** Atalho: payload cru → linhas. */
export function configRows(payload: Record<string, any> | null | undefined): ConfigRow[] {
  return configRowsFromSnapshot(configSnapshot(payload));
}

/**
 * Id determinístico do campo no DOM. É o contrato compartilhado entre o
 * formulário da config ao vivo (Chupim/Colhedor) e os links do gate: o diff do
 * gate aponta para `#cfg-field-<chave>` e o controle correspondente carrega
 * esse id. Fonte única evita que os dois lados divirjam em silêncio.
 */
export function configFieldId(key: string): string {
  const safe = String(key || '').trim().replace(/[^A-Za-z0-9_-]/g, '-');
  return 'cfg-field-' + safe;
}

/** Agrupa preservando a ordem do schema; `group: null` cobre campos sem grupo. */
export function configGroups(rows: ConfigRow[] | null | undefined): ConfigGroup[] {
  const out: ConfigGroup[] = [];
  const index = new Map<string, number>();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row) continue;
    const group = row.group ?? null;
    const mapKey = group ?? '\u0000';
    let at = index.get(mapKey);
    if (at == null) {
      at = out.length;
      index.set(mapKey, at);
      out.push({ group, rows: [] });
    }
    out[at].rows.push(row);
  }
  return out;
}

/** Valores iniciais do formulário: SÓ o que o backend declarou em `effective`.
 * Campo ausente fica fora do seed — preencher com envDefault seria rebatizar o
 * padrão do operador como escolha do usuário e o primeiro diff o enviaria. */
export function configFormSeed(rows: ConfigRow[] | null | undefined): Record<string, unknown> {
  const seed: Record<string, unknown> = {};
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || !row.hasValue || row.value === undefined) continue;
    seed[row.key] = row.value;
  }
  return seed;
}

/** Schema declarado (sem as linhas sintéticas de drift). */
export function configSchema(payload: Record<string, any> | null | undefined): ConfigSchemaField[] {
  const snapshot = configSnapshot(payload);
  if (!snapshot) return [];
  const out: ConfigSchemaField[] = [];
  const seen = new Set<string>();
  for (const raw of snapshot.schema) {
    const field = normalizeSchemaField(raw);
    if (!field || seen.has(field.key)) continue;
    seen.add(field.key);
    out.push(field);
  }
  return out;
}

function isAbsent(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
}

function coerceBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return null;
}

function coerceNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Diff do formulário contra a config efetiva: devolve SÓ as chaves que
 * realmente mudaram. A referência (effective) define a coerção — checkbox
 * entrega boolean, input numérico entrega string, e "5" vs 5 não é mudança.
 * Campo ausente no formulário nunca entra no patch (nem como remoção).
 */
export function configDiff(
  form: Record<string, unknown> | null | undefined,
  effective: Record<string, unknown> | null | undefined,
): ConfigDiff {
  const formObj = asObject(form) ?? {};
  const eff = asObject(effective) ?? {};
  const patch: Record<string, unknown> = {};
  const changedKeys: string[] = [];
  for (const [key, raw] of Object.entries(formObj)) {
    if (isAbsent(raw)) continue;
    const reference = eff[key];
    let next: unknown = raw;
    if (typeof reference === 'boolean') {
      const coerced = coerceBoolean(raw);
      if (coerced === null) {
        patch[key] = raw;
        changedKeys.push(key);
        continue;
      }
      next = coerced;
    } else if (typeof reference === 'number') {
      const coerced = coerceNumber(raw);
      if (coerced !== null) next = coerced;
    }
    if (reference !== undefined && reference !== null && Object.is(next, reference)) continue;
    patch[key] = next;
    changedKeys.push(key);
  }
  return { patch, changedKeys };
}

function metadataEntries(input: unknown): any[] {
  if (Array.isArray(input)) return input;
  const snapshot = configSnapshot(asObject(input));
  if (!snapshot) return [];
  return snapshot.schema.length > 0 ? snapshot.schema : configRowsFromSnapshot(snapshot);
}

function readFieldMeta(entry: any): { key: string; label: string; type: ConfigRowType; min: number | null; max: number | null } | null {
  const obj = asObject(entry);
  if (!obj) return null;
  const key = String(obj.key ?? '').trim();
  if (!key) return null;
  return {
    key,
    label: String(obj.label ?? key),
    type: obj.type === 'boolean' || obj.type === 'number' ? obj.type : 'unknown',
    min: numberOrNull(obj.min),
    max: numberOrNull(obj.max),
  };
}

/**
 * Validação local ANTES de enviar: usa type/min/max/label declarados no schema
 * e devolve erro legível por campo. Não clampa nem conserta — o backend é quem
 * aplica os clamps de `sanitizePatch`; validar aqui serve para o operador ver o
 * motivo sem gastar um round-trip.
 *
 * O 2º parâmetro aceita o array de schema, o snapshot ou o payload inteiro
 * (`{ config: {...} }`) — o que o chamador tiver em mãos.
 */
export function validateConfigForm(
  form: Record<string, unknown> | null | undefined,
  schemaOrPayload:
    | ReadonlyArray<ConfigSchemaField | ConfigRow>
    | Record<string, any>
    | null
    | undefined,
): ConfigValidationResult {
  const meta = new Map<string, ReturnType<typeof readFieldMeta>>();
  for (const entry of metadataEntries(schemaOrPayload)) {
    const field = readFieldMeta(entry);
    if (field) meta.set(field.key, field);
  }

  const formObj = asObject(form) ?? {};
  const errors: ConfigValidationError[] = [];
  for (const [key, raw] of Object.entries(formObj)) {
    if (isAbsent(raw)) continue;
    const field = meta.get(key);
    if (!field) {
      errors.push({ key, label: key, reason: 'unknown-key', message: `Campo desconhecido: "${key}".` });
      continue;
    }
    if (field.type === 'boolean') {
      if (coerceBoolean(raw) === null) {
        errors.push({ key, label: field.label, reason: 'type', message: `"${field.label}" deve ser ligado ou desligado.` });
      }
      continue;
    }
    if (field.type === 'number') {
      const n = coerceNumber(raw);
      if (n === null) {
        errors.push({ key, label: field.label, reason: 'type', message: `"${field.label}" deve ser um número.` });
      } else if (field.min != null && n < field.min) {
        errors.push({ key, label: field.label, reason: 'min', message: `"${field.label}" não pode ser menor que ${field.min}.` });
      } else if (field.max != null && n > field.max) {
        errors.push({ key, label: field.label, reason: 'max', message: `"${field.label}" não pode ser maior que ${field.max}.` });
      }
      continue;
    }
    // Tipo não declarado (campo fora do schema): o backend recusa a chave
    // desconhecida, então o erro local evita o round-trip.
    errors.push({ key, label: field.label, reason: 'unknown-key', message: `Campo sem schema declarado: "${key}".` });
  }
  return { ok: errors.length === 0, errors };
}
