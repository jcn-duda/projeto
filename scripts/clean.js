#!/usr/bin/env node
/**
 * Remove dist/ antes do build para impedir artefatos órfãos.
 *
 * O tsc sobrescreve o .js de quem continua existindo na fonte, mas não apaga o
 * .js de um módulo renomeado ou removido: o dist/ acumula código morto que a
 * suíte, o Docker e o runtime passam a carregar sem ninguém ver. A limpeza roda
 * ANTES do tsc e fica FORA do próprio dist/ — um script compilado dentro do
 * diretório que ele apaga se autodestrói antes de terminar. Por isso é JS puro
 * na raiz (o `tsconfig.include` só compila os fontes `.ts` de `scripts`), sem
 * dependência externa: `fs.rmSync` é do Node.
 *
 * `npm run build` encadeia este passo; `npm run clean` o expõe sozinho.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const dist = path.join(root, 'dist');

// No Windows, antivírus/indexador/editor podem segurar um handle por alguns
// instantes e o rm falhar com EBUSY/EPERM/ENOTEMPTY. maxRetries/retryDelay são
// opções nativas do fs.rmSync (sem dependência) que repetem a remoção com
// backoff antes de desistir. force:true torna a operação idempotente quando o
// dist/ ainda não existe.
fs.rmSync(dist, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
console.log('[clean] dist/ removido: o build sai sem artefatos órfãos.');
