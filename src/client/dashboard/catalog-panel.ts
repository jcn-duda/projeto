/* Adom Power-Movie — /dashboard: relatório de catálogo no load/poll (C3, ESM).
 * O /dashboard-status.json já carrega `catalog` = { ok, report } em TODA
 * resposta, mas a tela só pintava o relatório depois de um POST manual em
 * catalog-report — o número calculado a cada poll era jogado fora. Este módulo
 * popula #catalog_report a partir do payload, sem disparar POST nenhum.
 * O renderCatalogReport é consumido por hook; registro ausente mantém a seção
 * intacta, como a guarda antiga. Nada toca o DOM no import. */

import { isObject, own } from './core.js';
import { hooks } from './hooks.js';

export function renderCatalogPanel(root: any): void {
  // Sem a chave no payload (cache/rota antiga) não sobrescreve o estado inicial:
  // a seção continua com o convite a rodar a varredura.
  if (!isObject(root) || !own(root, 'catalog')) return;
  // A dependência interna obrigatória no renderCatalogReport (catalog-render.ts)
  // é o registro no hooks — has() mantém o early-return da guarda antiga sem
  // citar o símbolo global.
  if (!hooks.has('renderCatalogReport')) return;
  const catalog = root.catalog;
  if (!isObject(catalog)) return;
  // Relatório presente OU indisponibilidade explicada (ok:false + reason/hint);
  // qualquer outro shape não é um catálogo e não deve apagar a seção.
  if (!own(catalog, 'report') && catalog.ok !== false) return;
  hooks.call('renderCatalogReport', catalog);
}
