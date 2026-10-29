// Bloco `debrid` do /dashboard-status.json — extraído pela catraca de 400
// linhas (o arquivo de blocks estava exatamente no teto).
//
// `sweeps` é a foto SÍNCRONA das varreduras NATIVAS da AllDebrid
// (`sweepsStatusSnapshot`): quem fala com o gateway é o poll de fundo
// (`startSweepsPolling`), nunca este bloco. `null` = a ponte ainda não tirou a
// primeira foto — o cartão do painel diz "status nativo indisponivel" em vez de
// pintar zeros que ninguém mediu.
import type { AppServices } from './types.js';
import { sweepsStatusSnapshot } from '../utils/sweeps-native.js';

export async function debridBlock(services: AppServices, account: unknown): Promise<Record<string, unknown>> {
  const accounts = await services.debrid.dashboardAccounts(account);
  return {
    active: services.debrid.current()?.id || null,
    account,
    accounts,
    services: services.debrid.SERVICES,
    sweeps: sweepsStatusSnapshot(),
  };
}
