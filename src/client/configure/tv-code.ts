/* Adom Power-Movie - /configure: "Código para TV". Troca um link de manifest
 * por um código de 7 dígitos (POST /tv-code) que o app Power Movie digita no
 * controle. O código vale 30 min e só 2 usos (ver routes/tv-code.ts).
 * Serve ao link deste addon e, na seção "Código para outro addon", a qualquer
 * manifest colado (legendas, Torrentio...). */

import { state } from './state.js';

// Descarta resposta atrasada por saída: se o link mudou enquanto o pedido
// voava, o código que chegaria seria de algo que não está mais na tela.
const tokens: Record<string, number> = {};

function show(out: any, text: string, isError: boolean): void {
  out.textContent = text;
  out.className = isError ? 'tv-code-out tv-code-error' : 'tv-code-out';
  out.hidden = false;
}

/** Esconde o código deste addon: chamado quando o link de instalação muda. */
export function clearTvCode(): void {
  tokens.tvCodeOut = (tokens.tvCodeOut || 0) + 1;
  if (state.el.tvCodeOut) state.el.tvCodeOut.hidden = true;
}

function generate(url: string, outKey: string, intro: string): Promise<void> {
  const out = state.el[outKey];
  const token = (tokens[outKey] = (tokens[outKey] || 0) + 1);
  show(out, 'Gerando código…', false);
  return fetch('/tv-code', {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: url,
  })
    .then((r) => r.json().then((data: any) => ({ ok: r.ok, data })))
    .then(({ ok, data }) => {
      if (token !== tokens[outKey]) return;
      if (!ok || !data || !data.code) {
        show(out, (data && data.error) || 'Não foi possível gerar o código.', true);
        return;
      }
      const minutes = Math.round(Number(data.expiresInSec || 1800) / 60);
      show(out, `${intro}: ${data.code} — vale ${minutes} min e 2 usos.`, false);
    })
    .catch(() => {
      if (token === tokens[outKey]) show(out, 'Não foi possível gerar o código.', true);
    });
}

export function requestTvCode(): Promise<void> {
  const url = state.el.copyBtn.getAttribute('data-url') || '';
  if (!url) return Promise.resolve();
  return generate(url, 'tvCodeOut', 'Código para o app Power Movie');
}

export function requestOtherAddonCode(): Promise<void> {
  // Link colado do Stremio costuma vir como stremio://; o servidor quer https.
  const url = String(state.el.otherAddonUrl.value || '').trim().replace(/^stremio:\/\//i, 'https://');
  if (!url) {
    show(state.el.otherCodeOut, 'Cole o link do manifest do addon.', true);
    return Promise.resolve();
  }
  return generate(url, 'otherCodeOut', 'Código do addon');
}
