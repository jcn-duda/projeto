// Contadores e formato do banco de magnets. Módulo separado do magnetdb.ts
// porque aquele arquivo está no teto de 400 linhas.
//
// O DONO das linhas `mag:v1` é o núcleo Rust (`MagnetStateStore`): a
// enumeração, o formato da chave e o agregado vêm de `entries()`/`summary()`/
// `liveCount()` da ponte (`debrid-state-native.ts`). Aqui mora só o que o NODE
// ainda é dono: os totais por adapter que ele persiste em `mag_meta:v1:counts`
// e a régua de hash que a escrita usa antes de chamar o núcleo.

export const MAG_SIDES = ['alive', 'bad', 'lie'] as const;
export type MagSide = (typeof MAG_SIDES)[number];

export type AdapterTotals = {
  alive: number; bad: number; lie: number;
  // Aproximação operacional: renovações e remoções subtraem o TTL nominal,
  // não o restante exato de cada chave. As contagens são exatas; esta soma
  // serve apenas para mostrar uma média conservadora no painel sem scan O(n).
  // O rebuild pela ponte (`summary`) é a exceção: ele soma o restante REAL de
  // cada linha no núcleo.
  ttlRemainingSums: { alive: number; bad: number; lie: number };
};

const HASH_RE = /^[a-f0-9]{40}$/;

/**
 * Formato de hash que a chave mag suporta, em UM lugar só: o TS recusa antes de
 * chamar o núcleo e o Rust (`is_valid_hash`) recusa de novo do lado dele. Os
 * dois mapas são amarrados por teste — gravar um hash que o núcleo recusa cria
 * linha invisível na enumeração e divergência silenciosa entre painel e banco.
 */
export const isSupportedHash = (hash: string): boolean => HASH_RE.test(String(hash || '').toLowerCase());

export function emptyAdapterTotals(): AdapterTotals {
  return { alive: 0, bad: 0, lie: 0, ttlRemainingSums: { alive: 0, bad: 0, lie: 0 } };
}
