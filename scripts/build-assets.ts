#!/usr/bin/env node
/**
 * Copia para dist/ apenas os ASSETS NÃO-COMPILÁVEIS após o tsc.
 *
 * Preserva exatamente o que a imagem Docker e os testes em runtime dependem:
 * - src/public -> dist/src/public (HTML/CSS/imagens de /configure e dashboard)
 * - test/fixtures -> dist/test/fixtures (fixtures de teste)
 * - jackett-bludv -> dist/jackett-bludv (definições cardigann)
 *
 * `resolvers/` e os seis `*-resolver/` NÃO são mais copiados: o próprio tsc
 * compila a ilha inteira (include `resolvers/**` e `*-resolver/**`) e emite os
 * .js em dist/. Copiar fontes aqui sobrescrevia o emit e vazava `.ts` para
 * dentro da imagem. O filtro de `.ts` permanece como guarda-corpo para assets
 * que um dia carreguem tipo.
 *
 * Falha em voz alta caso qualquer diretório essencial falhe ao ser copiado ou não exista.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Identifica a raiz do projeto (onde mora package.json)
const up = path.join(__dirname, '..');
const root = fs.existsSync(path.join(up, 'package.json')) ? up : path.join(up, '..');
const distRoot = path.join(root, 'dist');

if (!fs.existsSync(distRoot)) {
  console.error(`[build-assets] Erro: diretório dist não encontrado em ${distRoot}. Execute o tsc antes.`);
  process.exit(1);
}

const assetsToCopy = [
  'src/public',
  'test/fixtures',
  'jackett-bludv',
];

function copyAndVerify(relativeSrc: string, relativeDst?: string) {
  const srcPath = path.join(root, relativeSrc);
  const dstPath = path.join(distRoot, relativeDst || relativeSrc);

  if (!fs.existsSync(srcPath)) {
    console.error(`[build-assets] Erro: caminho de origem obrigatório não existe: ${srcPath}`);
    process.exit(1);
  }

  fs.mkdirSync(dstPath, { recursive: true });
  // Nunca copia fonte `.ts`/`.d.ts`: esses arquivos pertencem ao tsc (emit) ou
  // ao contrato de tipos, não ao runtime de dist/.
  fs.cpSync(srcPath, dstPath, {
    recursive: true,
    filter: (source) => !source.endsWith('.ts'),
  });

  if (!fs.existsSync(dstPath)) {
    console.error(`[build-assets] Erro: falha ao verificar destino copiado: ${dstPath}`);
    process.exit(1);
  }

  const entries = fs.readdirSync(dstPath);
  if (entries.length === 0) {
    console.error(`[build-assets] Erro: diretório de destino copiado está vazio: ${dstPath}`);
    process.exit(1);
  }
}

/**
 * Núcleo Rust (napi): onde o Rust decide, o TS saiu, então `dist/rust/adom_napi.node`
 * é obrigatório para a suíte e para o `npm start`. O `clean` apaga o `dist/`; aqui
 * o binário volta de `rust/target` (release; debug só se não houver release). Sem
 * binário compilado o build segue: no Docker o estágio `rustcore` o põe depois.
 */
function copyNativeCore() {
  const libName = process.platform === 'win32'
    ? 'adom_napi.dll'
    : process.platform === 'darwin' ? 'libadom_napi.dylib' : 'libadom_napi.so';
  const candidates = ['release', 'debug']
    .map((profile) => path.join(root, 'rust', 'target', profile, libName))
    .filter((file) => fs.existsSync(file));
  if (!candidates.length) {
    console.warn(`[build-assets] Aviso: ${libName} não compilado; rode \`cargo build -p adom-napi --release\` em rust/.`);
    return;
  }
  const dst = path.join(distRoot, 'rust', 'adom_napi.node');
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(candidates[0], dst);
}

try {
  for (const asset of assetsToCopy) {
    if (fs.existsSync(path.join(root, asset))) {
      copyAndVerify(asset);
    }
  }

  // Preact vendor do painel precisa existir também no emit de Node (dist/src/client/painel/vendor)
  // para permitir execução direta dos testes dos módulos no Node.
  const vendorSrc = path.join(root, 'src/public/client/painel/vendor/preact.js');
  const vendorNodeDst = path.join(distRoot, 'src/client/painel/vendor/preact.js');
  if (fs.existsSync(vendorSrc)) {
    fs.mkdirSync(path.dirname(vendorNodeDst), { recursive: true });
    fs.copyFileSync(vendorSrc, vendorNodeDst);
  }

  copyNativeCore();

  console.log('[build-assets] Assets não-compiláveis copiados para dist/ com sucesso.');
} catch (err: any) {
  console.error('[build-assets] Falha crítica na cópia de assets:', err?.message || err);
  process.exit(1);
}
