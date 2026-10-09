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
const jackettConfig = fs.readFileSync(path.join(root, 'src', 'config', 'jackett.ts'), 'utf8');

// Bloco do JSON do card, isolado do heredoc `<<JSON … JSON` do
// `write_indexer_card`. O heredoc agora INTERPOLA — `${sitelink}` é o único
// ponto variável, porque o mesmo molde serve a mais de um card. O teste injeta
// um valor sentinela para poder validar a estrutura.
const SENTINEL = 'https://exemplo.invalid/';
const jsonPayload = (): any[] => {
  const start = script.indexOf('<<JSON\n');
  assert.notEqual(start, -1, 'o card precisa ser escrito por um heredoc JSON');
  const body = script.slice(start + '<<JSON\n'.length);
  const end = body.indexOf('\nJSON\n');
  assert.notEqual(end, -1, 'o heredoc JSON precisa terminar com o delimitador JSON');
  const raw = body.slice(0, end);
  // O único `$` tolerado no molde é o do sitelink: qualquer outro viraria
  // expansão silenciosa do shell dentro do JSON.
  assert.equal(
    (raw.match(/\$/g) || []).length,
    1,
    'o molde só pode interpolar ${sitelink}; outro $ viraria expansão no JSON',
  );
  return JSON.parse(raw.replace('${sitelink}', SENTINEL));
};

describe('entrypoint: bootstrap de indexers no volume do Jackett', () => {
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
    assert.match(script, /cat > "\$path" <<JSON/);
    assert.match(script, /mv "\$tmp" "\$card"/);
    // Nunca escreve direto no destino final.
    assert.doesNotMatch(script, /cat > "\$card"/);
  });

  test('não sobrescreve card existente e só loga quando cria', () => {
    assert.match(script, /if \[ ! -e "\$card" \]; then/);
    assert.match(
      script,
      /mv "\$tmp" "\$card" 2>\/dev\/null; then\s*\n\s*chown node:node "\$card" 2>\/dev\/null \|\| true\s*\n\s*echo "\[entrypoint\]/,
    );
    // Falha de escrita ou de move descarta o temp e nunca aposenta o stock.
    assert.match(script, /rm -f "\$tmp" 2>\/dev\/null \|\| true/);
    assert.match(script, /falha ao instalar o card apachetorrent-cardigann/);
    assert.match(script, /stock preservado[\s\S]*return/);
  });

  test('chown é best-effort: falha não derruba o boot', () => {
    assert.match(script, /chown node:node "\$card" 2>\/dev\/null \|\| true/);
  });

  test('molde único: um heredoc só, parametrizado pelo sitelink', () => {
    // Duas cópias do JSON divergiriam na próxima mudança de shape.
    assert.equal(
      (script.match(/<<JSON\n/g) || []).length,
      1,
      'o molde do card precisa morar num único heredoc',
    );
    assert.match(script, /write_indexer_card\(\) \{\s*\n\s*local path="\$1" sitelink="\$2"/);
  });

  test('payload é a lista completa com os 4 campos do molde', () => {
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
    assert.equal(byId.get('sitelink')?.value, SENTINEL);
    assert.equal(byId.get('cookieheader')?.type, 'hiddendata');
    assert.equal(byId.get('cookieheader')?.value, '');
    assert.equal(byId.get('lasterror')?.type, 'hiddendata');
    assert.equal(byId.get('lasterror')?.value, null);
    assert.equal(byId.get('tags')?.type, 'inputtags');
    assert.equal(byId.get('tags')?.value, '');
  });

  test('o card ativo do Apache nasce no domínio plural', () => {
    assert.match(script, /write_indexer_card "\$tmp" 'https:\/\/apachetorrents\.com\/'/);
  });

  test('arquiva o resíduo stock fora do diretório ativo, sem apagar divergência', () => {
    // O estacionamento é parametrizado por id: os dois indexers usam a MESMA
    // disciplina, em vez de uma cópia por indexer.
    assert.match(script, /park_stock_indexer\(\) \{\s*\n\s*local id="\$1"/);
    assert.match(script, /local stock="\$dir\/\$id\.json"/);
    assert.match(script, /mv "\$stock" "\$backup"/);
    // Backup já existente: só remove o ativo quando é idêntico.
    assert.match(script, /cmp -s "\$stock" "\$backup"/);
    // Divergência vai para um sufixo estável e reversível.
    assert.match(script, /mv "\$stock" "\$backup\.legacy"/);
    assert.match(script, /preservado no diretório ativo/);
    assert.ok(
      script.includes('park_stock_indexer apachetorrent'),
      'o stock do Apache continua sendo estacionado',
    );
  });
});

// O HDR foi REATIVADO via o card Cardigann do resolver local (porta 8707), que
// contorna a busca quebrada do site raspando as páginas de listagem. O card
// ATIVO precisa do nome da DEFINIÇÃO (`hdrtorrent-cardigann.json` — é o
// filename que vira o id no Jackett); o id `hdrtorrent-cardigann` está nas
// listas do addon (src/config/jackett.ts) e o stock C# `hdrtorrent.json`
// continua estacionado.
//
// Medido no Docker local (2026-09-19): o par antigo
// `reactivate_parked_card hdrtorrent` + `park_stock_indexer hdrtorrent` era
// ping-pong do MESMO arquivo stock — reativava e reestacionava em seguida, e o
// catálogo do Jackett ficava SEM o `hdrtorrent-cardigann` enquanto o addon o
// listava.
describe('entrypoint: HDR via card Cardigann do resolver local', () => {
  test('reativa o card do id Cardigann do diretório de desativados para o ativo', () => {
    assert.match(script, /reactivate_parked_card hdrtorrent-cardigann/);
    assert.match(
      script,
      /reactivate_parked_card\(\) \{[\s\S]*?local card="\$dir\/\$id\.json"[\s\S]*?local parked="\$disabled\/\$id\.json"/,
    );
    // A reativação NUNCA sobrescreve card já ativo.
    const reactivate = script.slice(script.indexOf('reactivate_parked_card() {'));
    const body = reactivate.slice(0, reactivate.indexOf('\n}\n'));
    assert.match(body, /\[ -e "\$card" \] && return 0/);
  });

  test('cria o card ativo se ausente, com o sitelink do domínio novo', () => {
    assert.match(script, /local hdr_card="\$dir\/hdrtorrent-cardigann\.json"/);
    assert.match(script, /if \[ ! -e "\$hdr_card" \]; then/);
    assert.match(script, /write_indexer_card "\$hdr_tmp" 'https:\/\/hdrtorrents\.net\/'/);
    assert.match(script, /mv "\$hdr_tmp" "\$hdr_card" 2>\/dev\/null; then/);
    assert.match(script, /rm -f "\$hdr_tmp" 2>\/dev\/null \|\| true/);
    assert.match(script, /indexer Cardigann hdrtorrent-cardigann registrado/);
  });

  test('o stock C# do HDR sai do diretório ativo e SEM ping-pong', () => {
    assert.ok(
      script.includes('park_stock_indexer hdrtorrent'),
      'o stock C# do HDR continua sendo estacionado',
    );
    const reactivateAt = script.search(/^\s*reactivate_parked_card hdrtorrent-cardigann\s*$/m);
    const parkAt = script.search(/^\s*park_stock_indexer hdrtorrent\s*$/m);
    assert.ok(reactivateAt !== -1 && parkAt !== -1, 'os dois calls precisam existir');
    assert.ok(reactivateAt < parkAt, 'reativar antes de estacionar o stock evita conflito');
    // O par antigo reativava o MESMO arquivo stock e o reestacionava em seguida:
    // o card ativo nunca nascia e o catálogo ficava sem o id novo. Busca
    // ancorada em linha inteira: o prefixo `hdrtorrent-cardigann` não casa por
    // engano e o comentário acima (que cita os dois calls inline) não conflita.
    assert.doesNotMatch(
      script,
      /^\s*reactivate_parked_card hdrtorrent\s*$/m,
      'o card ativo do HDR é o hdrtorrent-cardigann; reativar o id stock é ping-pong',
    );
  });

  test('o id hdrtorrent-cardigann está nas listas do addon', () => {
    assert.match(
      jackettConfig,
      /hdrtorrent-cardigann/,
      'hdrtorrent-cardigann precisa estar nas listas de indexers BR',
    );
  });
});

// As definições Cardigann vêm da IMAGEM (`/app/Jackett/Definitions`); o volume
// é só estado. O Dockerfile usa lista EXPLÍCITA de COPYs, então um yml novo em
// `jackett-bludv/` que fica fora da lista não existe no container — foi o
// defeito medido no Docker local em 2026-09-19: o addon listava
// `hdrtorrent-cardigann` e o Jackett nem tinha a definição para carregar.
describe('Dockerfile: definitions Cardigann copiadas para a imagem', () => {
  const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
  const ymls = fs
    .readdirSync(path.join(root, 'jackett-bludv'))
    .filter((file) => file.endsWith('.yml'));

  test('todo yml de jackett-bludv/ tem COPY para /app/Jackett/Definitions/', () => {
    assert.ok(
      ymls.length >= 9,
      `esperado ao menos 9 ymls em jackett-bludv, encontrados ${ymls.length}`,
    );
    for (const file of ymls) {
      assert.ok(
        dockerfile.includes(`jackett-bludv/${file} /app/Jackett/Definitions/`),
        `COPY ausente para jackett-bludv/${file} — a definição não existiria na imagem`,
      );
    }
  });
});

describe('TheRARBG: headers contra 403 sem migrar o card existente', () => {
  const definition = fs.readFileSync(path.join(root, 'jackett-bludv', 'therarbg.yml'), 'utf8');
  const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
  const expectedHeaders = {
    'User-Agent': ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'],
    Accept: ['application/json, text/plain, */*'],
    'Accept-Language': ['pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7'],
    'Sec-Fetch-Dest': ['empty'],
    'Sec-Fetch-Mode': ['cors'],
    'Sec-Fetch-Site': ['same-origin'],
  };

  // O contrato usa listas inline JSON, também válidas em YAML. Escalares
  // descartam a definição inteira no YamlDotNet, que exige List<string>.
  function readHeaders(source: string): Record<string, string[]> {
    const block = source.match(/^  headers:\r?\n((?:    [^\r\n]+\r?\n)+)/m)?.[1];
    assert.ok(block, 'o conjunto de headers precisa existir em search');
    const headers: Record<string, string[]> = {};
    for (const line of block.trim().split(/\r?\n/)) {
      const entry = line.trim().match(/^([A-Za-z0-9-]+):\s*(.+)$/);
      assert.ok(entry, 'cada header precisa ter nome e lista de valores');
      const value: unknown = JSON.parse(entry[2]);
      assert.ok(Array.isArray(value), `${entry[1]} precisa ser uma lista Cardigann`);
      assert.ok(value.every((item: unknown) => typeof item === 'string'));
      headers[entry[1]] = value;
    }
    return headers;
  }

  test('preserva identidade pública e domínios do card original', () => {
    assert.match(definition, /^id: therarbg$/m);
    assert.match(definition, /^name: TheRARBG$/m);
    assert.match(definition, /^language: en-US$/m);
    assert.match(definition, /^type: public$/m);
    assert.match(definition, /links:\s*\n  - https:\/\/therarbg\.to\//);
    assert.match(definition, /https:\/\/therarbg\.com\//);
    assert.doesNotMatch(script, /^\s*park_stock_indexer therarbg\s*$/m);
  });

  test('mantém pesquisa de filme e série e campos JSON que geram magnets', () => {
    assert.match(definition, /tv-search: \[q, season, ep\]/);
    assert.match(definition, /movie-search: \[q, imdbid\]/);
    assert.match(definition, /response:\s*\n\s+type: json/);
    assert.match(definition, /rows:\s*\n\s+selector: results/);
    for (const [field, selector] of [['infohash', 'h'], ['title', 'n'], ['size', 's'], ['seeders', 'se']]) {
      assert.match(definition, new RegExp(`    ${field}:\\s*\\n      selector: ${selector}\\s*\\n`));
    }
    assert.match(definition, /name: sort[\s\S]*default: -a/);
    assert.doesNotMatch(definition, /127\.0\.0\.1|localhost|^\s*info_flaresolverr:/m);
  });

  test('envia o conjunto comprovado em listas aceitas pelo Cardigann', () => {
    assert.deepEqual(readHeaders(definition), expectedHeaders);
  });

  test('o contrato rejeita valores escalares que derrubam a definição', () => {
    for (const [header, values] of Object.entries(expectedHeaders)) {
      const mutated = definition.replace(`${header}: ${JSON.stringify(values)}`, `${header}: ${JSON.stringify(values[0])}`);
      assert.notEqual(mutated, definition, `a mutação de ${header} precisa ser aplicada`);
      assert.throws(() => readHeaders(mutated), /precisa ser uma lista Cardigann/);
    }
  });

  test('sobrescreve a definição stock na imagem depois de copiar o Jackett', () => {
    const stock = dockerfile.indexOf('COPY --from=jackett /app/Jackett /app/Jackett');
    const patched = dockerfile.indexOf('COPY jackett-bludv/therarbg.yml /app/Jackett/Definitions/therarbg.yml');
    assert.ok(stock >= 0 && patched > stock);
  });
});

// Core dump desligado: o host grava `core.<pid>` no cwd (/app) e o Chromium do
// FlareSolverr crasha de tempos em tempos. Sem este ulimit, cada crash deixava
// ~700 MB na camada de escrita — foi o que encheu o disco da VPS e congelou o
// deploy automático por 24h.
describe('entrypoint: core dump não pode encher o disco', () => {
  test('desliga core dump antes de subir qualquer serviço', () => {
    const ulimit = script.match(/^ulimit -c 0\b/m);
    assert.ok(ulimit, 'o entrypoint precisa zerar o limite de core dump');
    // Início de linha: o cabeçalho do script CITA `run '[...]'` num comentário,
    // e casar a citação compararia a posição errada.
    const firstRun = script.match(/^run '\[/m);
    assert.ok(firstRun, 'o script precisa subir serviços com run [nome]');
    assert.ok(
      (ulimit.index as number) < (firstRun.index as number),
      'o ulimit precisa valer ANTES do primeiro serviço (ele herda do supervisor)',
    );
  });

  test('a falha do ulimit não derruba o boot', () => {
    // `set -u` está ligado e o shell pode recusar o ulimit em algum host.
    assert.match(script, /ulimit -c 0 2>\/dev\/null \|\| true/);
  });
});

// `rutor` e `kickasstorrents-ws` respondiam `tab crashed` no FlareSolverr com
// zero release — 28 crashes/hora, e o RuTor pendurando 100s por busca numa fila
// SERIAL. Tirar do .env não bastava: a lista efetiva vem do `ji` da config
// selada na URL, então instalação antiga continuava pedindo os dois.
describe('entrypoint: indexers que derrubam o Chromium ficam estacionados', () => {
  test('rutor e kickasstorrents-ws saem do diretório ativo', () => {
    assert.ok(script.includes('park_stock_indexer rutor'), 'rutor precisa ser estacionado');
    assert.ok(
      script.includes('park_stock_indexer kickasstorrents-ws'),
      'kickasstorrents-ws precisa ser estacionado',
    );
  });

  test('kickasstorrents-to NÃO é estacionado (foi revalidado e entrega)', () => {
    assert.ok(
      !/park_stock_indexer kickasstorrents-to\b/.test(script),
      'o -to foi religado depois de revalidado; estacioná-lo desfaria a decisão',
    );
    assert.ok(
      !/seed_parked_card kickasstorrents-to\b/.test(script),
      'nem semeado no diretório de desativados',
    );
  });

  test('estacionar não apaga: o card vai para o irmão -disabled', () => {
    // A mesma disciplina do Apache/HDR — reversível por um `mv` de volta.
    const park = script.slice(script.indexOf('park_stock_indexer() {'));
    const body = park.slice(0, park.indexOf('\n}\n'));
    assert.doesNotMatch(body, /rm -rf/, 'estacionar nunca remove em bloco');
    assert.match(body, /mv "\$stock" "\$backup"/);
  });
});
