#!/usr/bin/env node
/**
 * Fingerprint portátil da FONTE dos goldens (o `.ts` real que o `dist` compila).
 *
 * O SHA da fonte prende a geração ao conteúdo do `.ts`. Hash sobre os bytes
 * crus torna o MESMO conteúdo versionado dependente do checkout: com
 * `core.autocrlf=true` (Windows) a fonte tem CRLF; num checkout LF o hash muda
 * e o `--check` acusa "fonte mudou" — falso alarme de conteúdo.
 *
 * A política normaliza SÓ o fim de linha da fonte (CRLF → LF) em UTF-8 antes de
 * hashear. Nada de payload/hints/corpus e nada da saída (JSONL) passa por aqui:
 * esses continuam byte a byte. A normalização é textual e casa apenas o par
 * `\r\n`, então um `\r` isolado e escapes literais (`\r`) ficam intactos.
 *
 * `SOURCE_HASH_LINE_ENDINGS` vai no manifest (`sourceHashLineEndings`) para
 * documentar a política aplicada a `sourceSha256`/`functions[].sourceSha256`.
 */
import { createHash } from 'node:crypto';

/** Rótulo da política de fim de linha do hash da fonte. */
export const SOURCE_HASH_LINE_ENDINGS = 'LF';

/** Texto da fonte com CRLF → LF (só o par `\r\n`; CR isolado é preservado). */
export function sourceTextLf(bytes) {
  return Buffer.from(bytes).toString('utf8').replace(/\r\n/g, '\n');
}

/** SHA-256 (hex) do conteúdo da fonte com fim de linha LF. */
export function shaSourceLf(bytes) {
  return createHash('sha256').update(sourceTextLf(bytes), 'utf8').digest('hex');
}
