// Bloco `magnetBank` do /dashboard-status.json.
//
// F3.3: quem abre e agrega o `data/magnets.db` é o gateway (único escritor do
// acervo). O bloco ecoa o `GET /magnet-bank/status` da admin 8711 pela ponte
// (`bankStatusNative`) — o store do gateway porta a mesma régua do `status()`
// TS, então o shape que a view consome não muda. Sem resposta (gateway fora,
// sem credencial destrutiva, prazo vencido), estado neutro `ok:false` em vez
// de totais zerados fingidos — os zeros aqui são o "sem gateway" do padrão do
// bloco harvest, não acervo medido.
import { bankStatusNative } from '../utils/magnet-bank-native.js';

/** Estado neutro: admin sem resposta ou resposta que não é o painel. */
function offlineBlock(): Record<string, unknown> {
  return {
    ok: false,
    native: false,
    enabled: false,
    engine: 'sql',
    magnets: 0,
    sources: 0,
    works: 0,
    lastSeen: null,
    memoryMax: null,
    memoryEvictions: 0,
    queue: 0,
    queueMax: 0,
    byIndexer: [],
    error: 'magnet-bank-admin',
  };
}

/**
 * Bloco `magnetBank`. Eco fiel do corpo do gateway com `native:true` marcando
 * a origem — a view distingue "sem gateway" de "gateway ligado e acervo vazio".
 */
export async function magnetBankBlock(): Promise<Record<string, unknown>> {
  const native = await bankStatusNative();
  if (!native || native.status !== 200) return offlineBlock();
  return { ...native.body, native: true };
}
