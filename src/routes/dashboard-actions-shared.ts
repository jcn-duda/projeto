// Helpers compartilhados das ações do painel — módulo folha (não importa
// `dashboard-actions.ts` nem os arquivos de ações), para os dois lados do
// despacho e dos handlers extraídos usarem a MESMA normalização sem criar
// ciclo. Extraído para não haver cópia paralela que possa divergir (um
// hardening no teto de `max` num lado e no outro não seria pego por teste).
import type express from 'express';

/** `max` do corpo: número finito positivo vira inteiro; qualquer outra coisa
 * vira undefined (sem teto). Mesma semântica das ações pré-existentes. */
export function maxFromBody(req: express.Request): number | undefined {
  const raw = req.body?.max;
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : undefined;
}