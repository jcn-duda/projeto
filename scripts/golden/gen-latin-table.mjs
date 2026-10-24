#!/usr/bin/env node
/**
 * Gera `rust/crates/adom-core/src/latin_table.rs` a partir do golden
 * `rust/golden/matching-latin-ranges.jsonl` (varredura exaustiva do dist do TS).
 *
 * Por que uma tabela e não o crate `regex`: a classe `[\p{Script=Latin}\p{M}]`
 * do TS roda sobre o Unicode 17 do Node, e o crate `regex` publicado ainda usa
 * o Unicode 16. A varredura pegou essa diferença (faixas como U+1AE0..U+1AEB).
 * A tabela torna o porte exato por construção, e o teste
 * `matching_latin_ranges_golden.rs` garante que ela continua igual ao golden.
 *
 * Uso: `node scripts/golden/gen-latin-table.mjs` (depois de regenerar o golden).
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const GOLDEN = path.join(REPO, 'rust/golden/matching-latin-ranges.jsonl');
const OUT = path.join(REPO, 'rust/crates/adom-core/src/latin_table.rs');

const line = readFileSync(GOLDEN, 'utf8').trim();
const expected = JSON.parse(line).expected;
if (typeof expected !== 'string' || expected.length === 0) {
  console.error('[latin-table] golden sem intervalos');
  process.exit(1);
}

const pairs = expected.split(' ').map((range) => {
  const [a, b = a] = range.split('-');
  return `    (0x${a}, 0x${b}),`;
});

const body = `//! Tabela de code points de \`[\\p{Script=Latin}\\p{M}]\` (Unicode 17 do Node).
//!
//! GERADO por \`scripts/golden/gen-latin-table.mjs\` a partir de
//! \`rust/golden/matching-latin-ranges.jsonl\`. Não edite à mão: regere.
//! Intervalos inclusivos, ordenados e disjuntos.

pub(crate) const LATIN_OR_MARK_RANGES: &[(u32, u32)] = &[
${pairs.join('\n')}
];

/// Pertence à classe de \`LATIN_LETTER_RE\` do TS (letra latina ou marca).
pub(crate) fn is_latin_or_mark(cp: u32) -> bool {
    LATIN_OR_MARK_RANGES
        .binary_search_by(|&(start, end)| {
            if end < cp {
                std::cmp::Ordering::Less
            } else if start > cp {
                std::cmp::Ordering::Greater
            } else {
                std::cmp::Ordering::Equal
            }
        })
        .is_ok()
}
`;

writeFileSync(OUT, body);
console.log(`[latin-table] gerado: ${path.relative(REPO, OUT)} (${pairs.length} intervalos)`);
