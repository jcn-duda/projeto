import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Contrato do bootstrap de indexers do entrypoint do container único.
//
// O volume /config é estado que sobrevive a rebuild: ele nasce com o
// `apachetorrent.json` STOCK e SEM o card local `apachetorrent-cardigann.json`.
// Trocar a imagem não corrige isso — só o entrypoint pode, antes de subir o
// Jackett. O teste é estático/contratual de propósito: o alvo é um script bash
// e a suíte roda no Windows local, então ele amarra a ESTRUTURA que garante o
// comportamento (ordem, guarda de não-sobrescrita, escrita atômica, payload e
// arquivamento do stock) em vez de fingir executar bash.
const here = path.dirname(fileURLToPath(import.meta.url));
const root = fs.existsSync(path.join(here, '..', 'scripts', 'entrypoint.sh'))
  ? path.join(here, '..')
  : path.join(here, '..', '..');
const script = fs.readFileSync(path.join(root, 'scripts', 'entrypoint.sh'), 'utf8');

// Bloco do JSON do card, isolado do heredoc `<<'JSON' … JSON` (payload sem
// expansão: o operador nunca depende de env para o conteúdo).
const jsonPayload = (): any[] => {
  const start = script.indexOf("<<'JSON'\n");
  assert.notEqual(start, -1, 'o card precisa ser escrito por um heredoc JSON');
  const body = script.slice(start + "<<'JSON'\n".length);
  const end = body.indexOf('\nJSON\n');
  assert.notEqual(end, -1, 'o heredoc JSON precisa terminar com o delimitador JSON');
  return JSON.parse(body.slice(0, end));
};

describe('entrypoint: bootstrap do Cardigann Apache no volume do Jackett', () => {
  test('roda antes de subir o Jackett', () => {
    const call = script.match(/^bootstrap_jackett_indexers\s*$/m);
    assert.ok(call, 'o bootstrap precisa ser chamado no topo do script');
    const jackett = script.indexOf("run '[jackett]'");
    assert.notEqual(jackett, -1, 'o Jackett é iniciado pelo run com prefixo [jackett]');
    assert.ok(
      (call.index as number) < jackett,
      'o bootstrap precisa executar ANTES de `run \'[jackett]\'`',
    );
  });

  test('diretório configurável com default no volume real', () => {
    assert.match(
      script,
      /JACKETT_INDEXERS_DIR="\$\{JACKETT_INDEXERS_DIR:-\/config\/Jackett\/Indexers\}"/,
    );
    // O irmão de desativados é derivado do diretório ativo (testável junto).
    assert.match(script, /local dir="\$\{JACKETT_INDEXERS_DIR%\/\}"/);
    assert.match(script, /disabled="\$\{dir\}-disabled"/);
    assert.match(script, /mkdir -p "\$dir" "\$disabled"/);
  });

  test('grava de forma atômica (temp no mesmo diretório + mv)', () => {
    assert.match(script, /local tmp="\$card\.tmp\.\$\$"/);
    assert.match(script, /cat > "\$tmp" <<'JSON'/);
    assert.match(script, /mv "\$tmp" "\$card"/);
    // Nunca escreve direto no destino final.
    assert.doesNotMatch(script, /cat > "\$card"/);
  });

  test('não sobrescreve card existente e só loga quando cria', () => {
    assert.match(script, /if \[ ! -e "\$card" \]; then/);
    assert.match(
      script,
      /if mv "\$tmp" "\$card" 2>\/dev\/null; then\s*\n\s*chown node:node "\$card" 2>\/dev\/null \|\| true\s*\n\s*echo "\[entrypoint\]/,
    );
    // Falha no move descarta o temp sem deixar lixo.
    assert.match(script, /else\s*\n\s*rm -f "\$tmp" 2>\/dev\/null \|\| true/);
    assert.match(script, /falha ao instalar o card apachetorrent-cardigann/);
    // Falha de escrita nunca promove JSON parcial nem aposenta o stock.
    assert.match(script, /if \[ \$\? -ne 0 \]; then[\s\S]*stock preservado[\s\S]*return/);
  });

  test('chown é best-effort: falha não derruba o boot', () => {
    assert.match(script, /chown node:node "\$card" 2>\/dev\/null \|\| true/);
  });

  test('payload é a lista completa com os 4 campos e sitelink plural', () => {
    const payload = jsonPayload();
    assert.equal(payload.length, 4);
    const byId = new Map(payload.map((entry) => [entry.id, entry]));

    assert.deepEqual([...byId.keys()], ['sitelink', 'cookieheader', 'lasterror', 'tags']);
    // Mesmo molde de redetorrent-cardigann.json: id/type/name/value em todos.
    for (const entry of payload) {
      for (const field of ['id', 'type', 'name', 'value']) {
        assert.ok(field in entry, `campo ${field} ausente em ${entry.id}`);
      }
    }
    assert.equal(byId.get('sitelink')?.type, 'inputstring');
    assert.equal(byId.get('sitelink')?.name, 'Site Link');
    assert.equal(byId.get('sitelink')?.value, 'https://apachetorrents.com/');
    assert.equal(byId.get('cookieheader')?.type, 'hiddendata');
    assert.equal(byId.get('cookieheader')?.value, '');
    assert.equal(byId.get('lasterror')?.type, 'hiddendata');
    assert.equal(byId.get('lasterror')?.value, null);
    assert.equal(byId.get('tags')?.type, 'inputtags');
    assert.equal(byId.get('tags')?.value, '');
  });

  test('arquiva o resíduo stock fora do diretório ativo, sem apagar divergência', () => {
    assert.match(script, /local stock="\$dir\/apachetorrent\.json"/);
    assert.match(script, /mv "\$stock" "\$disabled\/apachetorrent\.json"/);
    // Backup já existente: só remove o ativo quando é idêntico.
    assert.match(script, /cmp -s "\$stock" "\$disabled\/apachetorrent\.json"/);
    // Divergência vai para um sufixo estável e reversível.
    assert.match(script, /mv "\$stock" "\$disabled\/apachetorrent\.json\.legacy"/);
    assert.match(script, /preservado no diretório ativo/);
    assert.match(script, /não foi possível estacionar o stock apachetorrent/);
  });
});
