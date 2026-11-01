/**
 * Só para rodar testes TS direto via tsx (FONTE, sem `npm run build`):
 * o default do `native-core.ts` resolve `../../rust/adom_napi.node` a partir
 * do MÓDULO — certo em `dist/` (dist/src/utils → dist/rust), errado na fonte
 * (src/utils → <repo>/rust). Aqui apontamos para o binário já compilado em
 * `dist/rust`, o MESMO que o runner oficial (`dist/test/setup-env.js`) aquece.
 *
 * Uso (com o setup-env oficial para as envs de DB):
 *   npx tsx --test --import ./test/setup-env.ts --import ./test/setup-tsx-core.ts <arquivos>
 */
import path from 'node:path';
import { setNativeCorePath } from '../src/utils/native-core.js';

setNativeCorePath(path.resolve('dist/rust/adom_napi.node'));
