/* Adom Power-Movie — /dashboard: registro de hooks (C3, ESM nativo).
 *
 * Continua sendo a quebra de ciclos do painel (nav↔status, probes/health/abas →
 * status), mas o REGISTRO saiu do topo dos módulos e virou wiring explícito do
 * entry: cada módulo apenas EXPORTA a função; é o entry.ts que chama
 * hooks.register(...). Assim nenhum módulo tem efeito de topo e a composição
 * fica visível num lugar só.
 *
 * O módulo PROVIDER exporta a função; o CONSUMIDOR chama hooks.call("nome", …).
 * Todo hook da página é OBRIGATÓRIO (cada provedor está no wiring do entry):
 * hook ausente é bug de composição e o call FALHA ALTO (throw) — no-op
 * silencioso mascarava o erro como comportamento. A única exceção é o
 * early-return do catálogo (catalog-panel → renderCatalogReport), que é
 * opcional de verdade e se verifica ANTES com hooks.has.
 *
 * O estado mutável entre módulos mora em state.ts (DashState) — nada aqui
 * centraliza estado. Este módulo é folha: não importa ninguém do dashboard.
 */

export type HookFn = (...args: any[]) => any;

const registry: Record<string, HookFn> = {};

export const hooks = {
  // Registrar duas vezes o mesmo nome sobrescreve de propósito: o entry roda
  // uma vez, e o sandbox de teste re-registra ao reconstruir o ambiente.
  register(name: string, fn: HookFn): void {
    registry[name] = fn;
  },
  // Só para hooks REALMENTE opcionais (early-return do catálogo): ausência
  // legítima de registro, não atalho para mascarar composição quebrada.
  has(name: string): boolean {
    return typeof registry[name] === 'function';
  },
  call(name: string, ...args: any[]): any {
    const fn = registry[name];
    if (typeof fn !== 'function') throw new Error('DashHooks.call: hook obrigatório ausente: ' + name);
    return fn(...args);
  },
  /** Limpa o registro; usado pelos testes entre ambientes. */
  reset(): void {
    for (const key of Object.keys(registry)) delete registry[key];
  },
};
