/* Adom Power-Movie - /configure: montagem do link de instalação e selo da
 * chave de debrid. O segmento é montado no browser, que não tem (nem pode
 * ter) o RESOLVE_SECRET; com o selo ligado no servidor a URL aparece primeiro
 * em texto puro e é trocada pela cifrada quando a resposta chega. */

import { state } from './state.js';

export function applySegment(segment: string): void {
  const el = state.el;
  const url = location.origin + '/' + segment + '/manifest.json';
  el.installUrl.textContent = url;
  // O servidor mantém teto defensivo de 8192: nunca ofereça link que
  // sabemos que virará 404 (catálogo enorme selecionado manualmente).
  const tooLong = segment.length > 8000;
  el.installBtn.href = tooLong ? '#' : url.replace(/^https?:/, 'stremio:');
  el.installBtn.setAttribute('aria-disabled', tooLong ? 'true' : 'false');
  el.copyBtn.disabled = tooLong;
  el.copyBtn.setAttribute('data-url', tooLong ? '' : url);
  el.installBtn.setAttribute('tabindex', tooLong ? '-1' : '0');
  if (tooLong) el.installUrl.textContent = 'Configuração grande demais: desmarque alguns indexadores.';
}

// A URL é remontada a cada tecla; pedir o selo junto renderia uma requisição
// por caractere digitado na chave. Só o último estado interessa.
export function requestSeal(segment: string): void {
  if (!state.instanceDefaults || !state.instanceDefaults.sealKeyEnabled) return;
  // Sem chave no segmento não há o que selar (P2P puro).
  if (!state.el.debridService.value || !state.el.debridApiKey.value.trim()) return;

  if (state.sealTimer !== null) clearTimeout(state.sealTimer);
  state.sealTimer = setTimeout(() => { sendSeal(segment); }, 250);
}

// O token descarta resposta atrasada de uma configuração que o usuário já
// mudou — sem ele, mexer rápido publicaria um link que não corresponde à tela.
function sendSeal(segment: string): void {
  const token = ++state.sealToken;
  fetch('/seal-config', {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: segment,
  })
    .then((r) => {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then((data: any) => {
      if (token !== state.sealToken || !data || !data.segment) return;
      applySegment(data.segment);
    })
    .catch(() => {
      // Selo indisponível não pode impedir a instalação: o link em texto puro
      // continua válido, e é ele que fica na tela.
    });
}
