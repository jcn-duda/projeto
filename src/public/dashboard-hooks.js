/* Adom Power-Movie — /dashboard: registro de hooks (Fase 1 do saneamento).
 * Quebra as dependências cíclicas/para-frente entre módulos (render↔probes,
 * status↔nav, status↔health, status↔timers/f3/catalog-panel, panels→general,
 * autofetch→af-stall, catalog-panel→catalog e os consumidores de loadStatus)
 * sem IIFE e sem bundler: um mapa nome → função em escopo global.
 *
 * Contrato:
 * - O módulo que OFERECE a função se registra no fim do próprio arquivo
 *   (DashHooks.register — a única execução no load dele, e é dado declarativo,
 *   não wiring; o boot continua sendo o único módulo que liga DOM).
 * - O módulo que CONSOME chama DashHooks.call("nome", args…). Todo hook da
 *   página é OBRIGATÓRIO (cada provedor está na composição do HTML): hook
 *   ausente é bug de composição e o call FALHA ALTO (throw) — no-op
 *   silencioso mascarava o erro como comportamento. A única exceção é o
 *   early-return do catálogo (catalog-panel → renderCatalogReport), que é
 *   opcional de verdade e se verifica ANTES com DashHooks.has.
 * - O ESTADO mutável entre módulos mora em dashboard-state.js (Fase 2:
 *   DashState) — nada aqui centraliza estado.
 *
 * Carrega PRIMEIRO (antes do estado e do core): todo módulo que se registra
 * no load o precisa. ES5 puro (Fire TV / smart TV). */
"use strict";

var DashHooks = {
  _fns: {},
  // Registrar duas vezes o mesmo nome sobrescreve em silêncio de propósito:
  // no load real cada módulo roda uma vez, e o sandbox de teste recarrega a
  // fonte inteira num escopo novo a cada factory.
  register: function (name, fn) { this._fns[name] = fn; },
  // Só para hooks REALMENTE opcionais (early-return do catálogo): ausência
  // legítima de registro, não atalho para mascarar composição quebrada.
  has: function (name) { return typeof this._fns[name] === "function"; },
  // `name` é sempre literal no chamador; os argumentos do hook vêm depois.
  call: function (name) {
    var fn = this._fns[name];
    if (typeof fn !== "function") throw new Error("DashHooks.call: hook obrigatório ausente: " + name);
    return fn.apply(null, Array.prototype.slice.call(arguments, 1));
  }
};
