/**
 * Adaptador Real-Debrid — montagem e superfície pública.
 *
 * Dividido por fronteiras reais para respeitar o teto de 400 linhas:
 * - `realdebrid-core.ts`: plumbing HTTP compartilhado, constantes de estado
 *   do torrent, limpeza best-effort e identidade do adaptador.
 * Este arquivo mantém só a saúde da conta (`accountStatus`) e REEXPORTA a
 * identidade. Inventário, status de torrent e remoção saíram para o oráculo de
 * teste (`test/helpers/pipeline-oracle/debrid-bodies/realdebrid.ts`): o
 * autofetch e a conta são nativos, e o Node não chama mais esses métodos.
 */
import {
  READY, readCall, listTorrents,
} from './realdebrid-core.js';

export { id, label, short, cacheCheck, autofetchSource, keyUrl } from './realdebrid-core.js';

/**
 * Saúde da conta para o `/debrid-status.json`: ocupação (o aviso por contagem
 * vem do `DEBRID_ACCOUNT_WARN_TOTAL`, como na AllDebrid) e validade do
 * premium. O RD não publica teto consultável — o limiar é nosso.
 */
async function accountStatus(apiKey: string) {
  const [user, rows] = await Promise.all([readCall(apiKey, '/user'), listTorrents(apiKey)]);
  let ready = 0;
  let active = 0;
  let error = 0;
  for (const t of rows) {
    const status = String(t?.status || '').toLowerCase();
    if (status === READY) ready += 1;
    else if (/^(magnet_error|error|virus|dead)$/.test(status)) error += 1;
    else active += 1;
  }
  const expiration = user?.expiration ? new Date(String(user.expiration)).getTime() : NaN;
  return {
    magnets: rows.length,
    ready,
    active,
    error,
    premiumUntil: Number.isFinite(expiration) ? expiration : null,
  };
}

export { accountStatus };
