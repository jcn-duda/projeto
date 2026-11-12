/* Adom Power-Movie - /configure: "Código para TV". Troca o link de instalação
 * corrente por um código de 7 dígitos (POST /tv-code) que o app Power Movie
 * digita no controle. O código vale 30 min e só 2 usos (ver routes/tv-code.ts). */

import { state } from './state.js';

// Descarta resposta atrasada: se o link mudou enquanto o pedido voava, o
// código que chegaria seria de uma configuração que não está mais na tela.
let requestToken = 0;

function show(text: string, isError: boolean): void {
  const out = state.el.tvCodeOut;
  out.textContent = text;
  out.className = isError ? 'tv-code-out tv-code-error' : 'tv-code-out';
  out.hidden = false;
}

/** Esconde o código: chamado quando o link de instalação muda. */
export function clearTvCode(): void {
  requestToken++;
  if (state.el.tvCodeOut) state.el.tvCodeOut.hidden = true;
}

export function requestTvCode(): Promise<void> {
  const url = state.el.copyBtn.getAttribute('data-url') || '';
  if (!url) return Promise.resolve();
  const token = ++requestToken;
  show('Gerando código…', false);
  return fetch('/tv-code', {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: url,
  })
    .then((r) => r.json().then((data: any) => ({ ok: r.ok, data })))
    .then(({ ok, data }) => {
      if (token !== requestToken) return;
      if (!ok || !data || !data.code) {
        show((data && data.error) || 'Não foi possível gerar o código.', true);
        return;
      }
      const minutes = Math.round(Number(data.expiresInSec || 1800) / 60);
      show(`Código para o app Power Movie: ${data.code} — vale ${minutes} min e 2 usos.`, false);
    })
    .catch(() => {
      if (token === requestToken) show('Não foi possível gerar o código.', true);
    });
}
