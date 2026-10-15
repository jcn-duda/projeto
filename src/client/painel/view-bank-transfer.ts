// Card "Cópia de Segurança" da aba Magnets: exportar o banco vivo para um
// arquivo e importar um arquivo de volta (MESCLA — nunca apaga o que existe).
// O caso de uso medido: guardar o acervo contra pane de disco na VPS, e levar
// o acervo da VPS para o Docker local para testar com dado real.
import { html, useRef, useState } from './vendor/preact.js';
import { Card } from './kit.js';
import { useConfirm } from './confirm.js';
import { getPainelState } from './store.js';
import { exportBank, importBank, importSummary } from './bank-transfer.js';

type Feedback = { text: string; ok: boolean } | null;

function download(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function BankTransferCard() {
  const confirm = useConfirm();
  const input = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState<'' | 'export' | 'import'>('');
  const [feedback, setFeedback] = useState<Feedback>(null);

  const onExport = async () => {
    if (busy) return;
    setBusy('export');
    setFeedback({ text: 'Gerando o arquivo… (o acervo inteiro, pode levar um tempo)', ok: true });
    const out = await exportBank(getPainelState().token);
    setBusy('');
    if (!out.ok) return setFeedback({ text: `Falha: ${out.error}`, ok: false });
    download(out.blob, out.fileName);
    setFeedback({ text: `Exportado: ${out.fileName} (${(out.blob.size / 1024 / 1024).toFixed(1)} MB)`, ok: true });
  };

  const onFile = async (event: any) => {
    const file: File | undefined = event?.target?.files?.[0];
    if (input.current) input.current.value = '';
    if (!file || busy) return;
    const approved = await confirm(
      `Importar "${file.name}" (${(file.size / 1024 / 1024).toFixed(1)} MB) no banco de magnets?`,
      {
        title: 'Importar banco de magnets',
        detail: 'Os registros são MESCLADOS com o que já existe: nada é apagado, e importar o mesmo arquivo de novo não duplica.',
        confirmLabel: 'Importar',
      },
    );
    if (!approved) return;
    setBusy('import');
    setFeedback({ text: 'Importando…', ok: true });
    const out = await importBank(getPainelState().token, file, file.name);
    setBusy('');
    setFeedback(out.ok ? { text: `Importado: ${importSummary(out)}`, ok: true } : { text: `Falha: ${out.error}`, ok: false });
  };

  return html`
    <${Card} title="Cópia de Segurança do Banco">
      <p style="color: var(--muted); margin: 0 0 var(--space-2); font-size: var(--font-floor);">
        Exporta o banco vivo inteiro (magnets, fontes e obras) num arquivo .ndjson.gz.
        A importação MESCLA com o que já existe — nada é apagado.
      </p>
      <div style="display: flex; gap: var(--space-2); flex-wrap: wrap;">
        <button class="painel-btn painel-btn-accent" disabled=${Boolean(busy)} onClick=${onExport}>
          ${busy === 'export' ? 'Exportando…' : 'Exportar'}
        </button>
        <button class="painel-btn" disabled=${Boolean(busy)} onClick=${() => input.current?.click()}>
          ${busy === 'import' ? 'Importando…' : 'Importar arquivo…'}
        </button>
        <input
          ref=${input}
          type="file"
          accept=".gz,.ndjson,application/gzip"
          style="display: none;"
          onChange=${onFile}
        />
      </div>
      ${feedback ? html`
        <div class=${'painel-feedback ' + (feedback.ok ? 'painel-feedback-ok' : 'painel-feedback-err')} role="status">
          ${feedback.text}
        </div>
      ` : null}
    </${Card}>
  `;
}
