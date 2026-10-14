// Estruturas da cadeia medida em outubro/2026; valores inteiramente sintéticos.
// Não carregar tmp/callback2.html: a captura do operador contém sessão real.
export const siteUrl = 'https://bludvfilmes1.xyz';
export const postUrl = `${siteUrl}/filme-fixture-2026/`;
export const magnet = `magnet:?xt=urn:btih:${'a'.repeat(40)}&dn=Filme.Fixture.2026&tr=udp%3A%2F%2Ftracker.example%3A80`;
export const legacyUrl = 'https://systemads1.com/go/fixture-legado';
export const legacyMagnet = `magnet:?xt=urn:btih:${'b'.repeat(40)}&dn=Filme.Legado.2026`;

export function gateUrl(id = 101): string {
  return `${siteUrl}/gate/go/${id.toString(16).padStart(16, 'a')}?p=${id}`;
}

export function gatePost(id = 101): string {
  return `<h1>Filme Fixture Torrent (2026) WEB-DL 1080p Dublado</h1>
    <h3>VERSÃO MKV DUBLADO</h3>
    <strong>SERVIDOR PARA DOWNLOAD WEB-DL 1080p (1.65 GB)</strong>
    <a class="customButton" href="${gateUrl(id)}">Magnet-Link<div class="eas-video-overlay-wrapper"></div></a>`;
}

export function multiGatePost(id = 101): string {
  return `${gatePost(id)}
    <h3>VERSÃO MP4 LEGENDADO</h3>
    <strong>SERVIDOR PARA DOWNLOAD Blu-ray 720p (897 MB)</strong>
    <a href='/gate/go/${(id + 1).toString(16).padStart(16, 'a')}?p=${id + 1}' class='customButton'>Magnet-Link</a>`;
}

export const legacyButton = `<h3>VERSÃO MKV DUBLADO</h3>
  <strong>SERVIDOR PARA DOWNLOAD WEB-DL 2160p (4.5 GB)</strong>
  <a href="${legacyUrl}" class="customButton">Magnet-Link</a>`;

export function searchPage(url = postUrl): string {
  return `<div class="posts"><div class="post"><div class="title">
    <a href="${url}">Filme Fixture Torrent (2026) WEB-DL 1080p Dublado</a>
    </div></div></div>`;
}

export function callbackHtml(value = magnet): string {
  return `<html><body><a id="download" href="${value.replaceAll('&', '&amp;')}">Magnet-Link</a></body></html>`;
}
