// `/stream` do Node está APOSENTADO (F4.4). O corte nativo do gateway
// (`ROUTES_RUST=stream`, default) é quem responde o protocolo Stremio; o Node
// não monta mais lista de streams (o pipeline TS saiu) e por isso a rota
// devolve erro explícito em vez de uma lista vazia silenciosa:
//
// - 410 Gone quando o gateway nativo é o dono da rota (`GATEWAY=on` +
//   `ROUTES_RUST` contendo `stream`) — o pedido nunca deveria chegar aqui;
// - 503 no resto (Node servindo a 7000 sem gateway): não há pipeline local
//   para responder. Rollback do corte é imagem/commit anterior + GATEWAY=off,
//   não esta rota.
//
// Os 410/503 são o sinal para o operador e para o teste de contrato; o corpo é
// JSON mínimo no mesmo formato de erro das outras rotas.
import type { AppServices } from './types.js';

/** Status/mensagem da rota conforme o modo do processo (puro p/ teste). */
export function retiredStreamStatus(env: NodeJS.ProcessEnv = process.env): { status: number; message: string } {
  const routes = String(env.ROUTES_RUST || '')
    .split(',')
    .map((token) => token.trim())
    .filter(Boolean);
  const gatewayOn = String(env.GATEWAY || '').trim() === 'on';
  if (gatewayOn && routes.includes('stream')) {
    return {
      status: 410,
      message: 'stream movido para o gateway nativo (GATEWAY=on, ROUTES_RUST=stream); use a porta 7000',
    };
  }
  return {
    status: 503,
    message: 'busca de stream indisponível neste processo: o /stream nativo exige o gateway (GATEWAY=on, ROUTES_RUST=stream)',
  };
}

/** Erro com status HTTP: o addon-router traduz em resposta (nunca 500 opaco). */
export interface StreamHttpError extends Error {
  status: number;
}

function createStreamHandler(_services: AppServices) {
  return async (): Promise<never> => {
    const { status, message } = retiredStreamStatus();
    const err = new Error(message) as StreamHttpError;
    err.status = status;
    throw err;
  };
}

export { createStreamHandler };
