// "Sou o processo principal?" import-safe para os shims ESM.
//
// Em ESM não existe `require.main === module`. A comparação correta é entre o
// `import.meta.url` do chamador e a URL de `process.argv[1]` (o script de
// entrada). `pathToFileURL` normaliza as duas formas no MESMO padrão
// `file:///...`, inclusive no Windows (letra de drive + separadores), e o
// fallback case-insensitive cobre a variação de caixa do drive que o SO não
// distingue. `argv[1]` ausente (node -e, REPL, `node --test`) devolve false:
// sem entrypoint não há "principal" para reivindicar.
import { pathToFileURL } from 'node:url';

// `entry` é injetável só para teste; em produção vale `process.argv[1]`.
export function isMain(importMetaUrl: string, entry: string | undefined = process.argv[1]): boolean {
  if (!entry) return false;
  try {
    const entryUrl = pathToFileURL(entry).href;
    if (entryUrl === importMetaUrl) return true;
    return process.platform === 'win32'
      && entryUrl.toLowerCase() === String(importMetaUrl).toLowerCase();
  } catch {
    return false;
  }
}
