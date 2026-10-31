// Bloco `debrid` do /dashboard-status.json — extraído pela catraca de 400
// linhas (o arquivo de blocks estava exatamente no teto).
//
// `sweeps` é a foto SÍNCRONA das varreduras NATIVAS da AllDebrid
// (`sweepsStatusSnapshot`): quem fala com o gateway é o poll de fundo
// (`startSweepsPolling`), nunca este bloco. `null` = a ponte ainda não tirou a
// primeira foto — o cartão do painel diz "status nativo indisponivel" em vez de
// pintar zeros que ninguém mediu.
//
// `inventory` é a foto PREGUIÇOSA do inventário NATIVO da conta AllDebrid
// (`GET /debrid/inventory` na admin 8711, cache de 30 s na ponte): a contagem
// do `knownBefore` que o gateway Rust guarda em memória. A chave existe
// SEMPRE; `null` = ponte fora/snapshot frio — "desconhecido", nunca 0.
import type { AppServices } from './types.js';
import { sweepsStatusSnapshot } from '../utils/sweeps-native.js';
import { fetchNativeDebridInventory } from '../providers/debrid-inventory-native.js';

export async function debridBlock(services: AppServices, account: unknown): Promise<Record<string, unknown>> {
  const accounts = await services.debrid.dashboardAccounts(account);
  const inventory = await fetchNativeDebridInventory();
  return {
    active: services.debrid.current()?.id || null,
    account,
    accounts,
    services: services.debrid.SERVICES,
    sweeps: sweepsStatusSnapshot(),
    inventory,
  };
}
