/* Adom Power-Movie — /painel: núcleo de helpers puros (ESM nativo).
 *
 * Migrado de src/client/dashboard/core.ts (Etapa 6) para o painel não depender
 * mais do dashboard legado. Aqui só vive helper PURO: nada de DOM no import —
 * `document`/`window`/`fetch` só seriam tocados quando chamados, e nenhuma
 * função deste módulo os toca. O estado mutável vive em store.ts. */

// Fase 4 — procedência do painel (_origem). Limiar alinhado ao Chupim:
// uptime baixo + amostra pode subcontar L2 após restart.
export const AMOSTRA_CEDO_S = 300;

export function isObject(value: any): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function own(object: any, key: string): boolean {
  return isObject(object) && Object.prototype.hasOwnProperty.call(object, key);
}

export function first(object: any, names: string[], fallback: any): any {
  let i: number;
  if (!object) return fallback;
  for (i = 0; i < names.length; i += 1) {
    if (object[names[i]] !== undefined && object[names[i]] !== null) return object[names[i]];
  }
  return fallback;
}

export function valueText(value: any): string {
  if (value === undefined || value === null || value === '') return '—';
  if (typeof value === 'boolean') return value ? 'sim' : 'não';
  if (typeof value === 'number') return isFinite(value) ? String(value) : '—';
  if (typeof value === 'object') return 'ver detalhes';
  return String(value);
}

export function isAmostraCedo(uptimeS: any): boolean {
  const n = Number(uptimeS);
  return isFinite(n) && n >= 0 && n < AMOSTRA_CEDO_S;
}

export function origemOf(map: any, key: string): string | null {
  let o: any;
  if (!isObject(map) || !key) return null;
  o = map._origem;
  if (!isObject(o)) return null;
  if (o[key] === 'duravel' || o[key] === 'amostra' || o[key] === 'naomedido') return o[key];
  return null;
}

export function origemTitle(kind: string | null, uptimeS: any): string {
  if (kind === 'duravel') return 'Persistente (L1/L2 ou fila durável)';
  if (kind === 'amostra') {
    return isAmostraCedo(uptimeS)
      ? 'Amostra deste processo (uptime baixo; pode subcontar o L2)'
      : 'Amostra deste processo (≠ L1/L2)';
  }
  if (kind === 'naomedido') return 'Ainda não medido neste processo';
  return '';
}

export function origemValue(value: any, kind: string | null): string {
  // Fail-open: sem _origem o número antigo continua; só naomedido vira "—".
  if (kind === 'naomedido') return '—';
  return valueText(value);
}
