#!/usr/bin/env node
/**
 * Salva o HTML de uma página como fixture de teste.
 *
 *   node scripts/capture-fixture.js <url> <arquivo-destino>
 *
 * Existe porque fixture reconstruída à mão prova menos que HTML de verdade:
 * ela confirma que o parser faz o que o autor do parser achou que fazia, não
 * que ele casa com o site. Use isto para trocar as reconstruídas por captura
 * real quando um site quebrar — e LEIA o arquivo antes de commitar: página de
 * post costuma trazer link de afiliado, id de sessão e às vezes o IP de quem
 * baixou no HTML.
 */
const fs = require('node:fs');
const path = require('node:path');

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122 Safari/537.36';

async function main() {
  const [url, target] = process.argv.slice(2);
  if (!url || !target) {
    console.error('uso: node scripts/capture-fixture.js <url> <arquivo-destino>');
    process.exit(2);
  }

  const response = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    console.error(`http_${response.status} ao buscar ${url}`);
    process.exit(1);
  }

  const html = await response.text();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, html, 'utf8');
  console.log(`${target}: ${html.length} bytes de ${url}`);
  console.log('revise o arquivo antes de commitar (afiliado/sessão/IP no HTML).');
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
