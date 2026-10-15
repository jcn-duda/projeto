import { num } from './helpers.js';

// Fábrica (padrão debrid-autofetch-seeds): bloco do reconcile da posse
// (`adsub` × conta real), extraído do debrid.ts para o arquivo caber no teto
// de 400 linhas. Espalhado no objeto debrid com as mesmas chaves.
export const reconcile = () => ({
  // Reconcile da posse (`adsub`) com a conta real: ready + etiqueta ativa +
  // não preexistente + prova de que o upload não é re-add do usuário sai da
  // conta, com purga da posse e o marcador anti-reenchimento do 8.14. Fecha
  // o canto que a limpeza por busca não alcança (lote estourado, delete
  // recusado, hash omitido na resposta). Fire-and-forget, escopo B-2 (só
  // operador), anti-reentrada e intervalo mínimo por conta. false desliga
  // (rollback de uma linha).
  reconcile: String(process.env.DEBRID_RECONCILE || 'false') === 'true',
  // Intervalo mínimo entre rodadas POR CONTA: o gatilho é a checagem (que pode
  // rodar várias vezes por minuto) e o /magnet/status em fundo não acompanha
  // esse ritmo. Rodadas mais próximas que isso são puladas.
  reconcileMinIntervalMs: Math.max(0, num(process.env.DEBRID_RECONCILE_MIN_INTERVAL_MS, 300_000)),
  // Teto de remoções por rodada, na ordem dos mais antigos. Clamp 0..50;
  // 0 desliga o reconcile mesmo com o knob acima ligado.
  reconcileMaxPerRound: Math.min(50, Math.max(0, Math.trunc(num(process.env.DEBRID_RECONCILE_MAX_PER_ROUND, 25)))),
  // Margem anti-re-add: magnet cujo upload é MAIS NOVO que a etiqueta de posse
  // + esta margem é re-add do usuário e NUNCA sai. A margem cobre a defasagem
  // de relógio entre a AllDebrid e este processo.
  reconcileAgeMarginMs: Math.max(0, num(process.env.DEBRID_RECONCILE_AGE_MARGIN_MS, 600_000)),
  // Piso de idade: só elegível se já existe há pelo menos isto. O incidente que
  // motivou: o reconcile apagou um pack recém-esquentado pelo autofetch. 0 desliga.
  reconcileMinAgeMs: Math.max(0, num(process.env.DEBRID_RECONCILE_MIN_AGE_MS, 24 * 3600 * 1000)),
  // Piso de ocupação (como HARVEST_EVICT_FLOOR): conta folgada não apaga nada. 0 desliga.
  reconcileFloor: Math.max(0, Math.trunc(num(process.env.DEBRID_RECONCILE_FLOOR, 0))),
});
