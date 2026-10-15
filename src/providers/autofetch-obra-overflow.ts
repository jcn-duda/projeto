// Overflow de UPGRADE do teto por obra (C11), extraído do `autofetch-obra.ts`
// para a catraca de linhas. A decisão é pura: recebe o registro persistido da
// obra e o candidato, e diz se cabe UMA reserva extra (cap+1).
import { isAutofetchTargetQuality } from '../utils/autofetch-pools.js';
import type { ObraEntry, ObraReserveInput } from './autofetch-obra.js';

/** Peso de faixa para comparar o upgrade; faixa desconhecida = -1 (não prova). */
export function qualityRank(q: unknown): number {
  const value = String(q || '').toLowerCase();
  if (value === '2160p') return 4;
  if (value === '1080p') return 3;
  if (value === '720p') return 2;
  if (value === '480p') return 1;
  if (value === 'sd') return 0;
  return -1;
}

/**
 * Overflow de UPGRADE (C11): com o cap do pool `br` cheio, concede UMA reserva
 * extra quando o candidato é faixa-alvo AUSENTE no registro e SUPERIOR ao pior
 * BR já registrado. Sem isso, três BRs de 720p consumiam a vaga da obra e o
 * 1080p que a sonda acabou de achar nunca entrava — exatamente o upgrade que a
 * sonda existe para achar. Conservador por construção: exige prova de faixa
 * (registro com qualidade conhecida), não remove magnet antigo e grava o
 * aceite com `overflow:true`, de modo que `counts > cap` já barra a próxima
 * (UMA por janela). Pool diferente de `br` e faixa fora das alvo não entram.
 */
export function overflowUpgradeAllowed(entries: ObraEntry[], input: ObraReserveInput): boolean {
  if (String(input.pool || '') !== 'br') return false;
  const quality = String(input.quality || '').toLowerCase();
  if (!isAutofetchTargetQuality(quality)) return false;
  const brEntries = entries.filter((e) => String(e.pool || '') === 'br');
  if (brEntries.some((e) => e.overflow === true)) return false;
  if (brEntries.some((e) => String(e.quality || '').toLowerCase() === quality)) return false;
  const ranks = brEntries.map((e) => qualityRank(e.quality)).filter((r) => r >= 0);
  if (!ranks.length) return false;
  return qualityRank(quality) > Math.min(...ranks);
}
