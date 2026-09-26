import { html } from './vendor/preact.js';
import { Card, StatNumber, ProgressBar } from './kit.js';

export interface ViewSondaProps {
  harvest?: Record<string, any>;
  f3?: Record<string, any>;
  metrics?: Record<string, any>;
}

export function ViewSonda({ harvest, f3, metrics }: ViewSondaProps) {
  const h = harvest || {};
  const coverage = f3 || {};
  const m = metrics?.counters || {};

  const probeScheduled = m['autofetch.brProbe.scheduled.evidence'] || 0;
  const probeUpgrade = m['autofetch.brProbe.scheduled.upgrade'] || 0;
  const probeFound = m['autofetch.brProbe.found'] || 0;
  const probeEmpty = m['autofetch.brProbe.empty'] || 0;
  const probeFailed = m['autofetch.brProbe.failed'] || 0;
  const probeCapped = m['autofetch.brProbe.capped'] || 0;

  const totalCompleted = probeFound + probeEmpty + probeFailed + probeCapped;
  const hitRate = totalCompleted > 0 ? Math.round((probeFound / totalCompleted) * 100) : 0;

  const popCov = coverage.popularCoverage != null ? Math.round(Number(coverage.popularCoverage) * 100) : null;
  const brWarm = coverage.brWarmRate != null ? Math.round(Number(coverage.brWarmRate) * 100) : null;
  const discRate = coverage.discoveryRate != null ? Math.round(Number(coverage.discoveryRate) * 100) : null;

  const preview = Array.isArray(h.queuePreview) ? h.queuePreview : [];
  const probeItems = preview.filter((item: any) => item.brProbe);

  return html`
    <div class="painel-grid">
      <${Card}
        title="Sonda BR Dirigida"
        badge=${{
          text: `${hitRate}% SUCESSO`,
          variant: hitRate >= 50 ? 'ok' : hitRate > 0 ? 'warn' : 'neutral',
        }}
      >
        <${StatNumber} value=${probeFound} target=${totalCompleted} label="${hitRate}% encontrada(s)" />
        <${ProgressBar} percent=${hitRate} variant=${hitRate >= 50 ? 'ok' : 'warn'} />
        <p style="color: var(--muted); margin-top: var(--space-2); font-size: var(--font-floor);">
          Agendadas: ${probeScheduled + probeUpgrade} (${probeUpgrade} upgrades) · Vazias: ${probeEmpty} · Falhas: ${probeFailed + probeCapped}
        </p>
      </${Card}>

      <${Card} title="Cobertura F3 (Coorte IMDb)">
        <div style="display: flex; flex-direction: column; gap: var(--space-2);">
          <div style="display: flex; justify-content: space-between;">
            <span style="color: var(--muted);">Populares em Cache (⚡)</span>
            <span style="font-weight: 600;">${popCov != null ? `${popCov}%` : '—'}</span>
          </div>
          <${ProgressBar} percent=${popCov || 0} variant="ok" />

          <div style="display: flex; justify-content: space-between; margin-top: var(--space-1);">
            <span style="color: var(--muted);">Taxa BR Aquecido</span>
            <span style="font-weight: 600;">${brWarm != null ? `${brWarm}%` : '—'}</span>
          </div>
          <${ProgressBar} percent=${brWarm || 0} variant="ok" />

          <div style="display: flex; justify-content: space-between; margin-top: var(--space-1);">
            <span style="color: var(--muted);">Taxa de Descoberta BR</span>
            <span style="font-weight: 600;">${discRate != null ? `${discRate}%` : '—'}</span>
          </div>
          <${ProgressBar} percent=${discRate || 0} variant="ok" />
        </div>
      </${Card}>

      <${Card} title="Sondas em Fila Ativa">
        ${probeItems.length === 0 ? html`
          <p style="color: var(--muted); font-size: var(--font-floor);">Nenhuma sonda dirigida pendente na fila.</p>
        ` : html`
          <table class="painel-table">
            <thead>
              <tr>
                <th>Obra</th>
                <th>Tipo</th>
                <th>Motivo</th>
              </tr>
            </thead>
            <tbody>
              ${probeItems.map((item: any) => html`
                <tr>
                  <td>${item.imdbId}${item.season ? ` S${String(item.season).padStart(2, '0')}` : ''}${item.episode ? `E${String(item.episode).padStart(2, '0')}` : ''}</td>
                  <td>${item.type}</td>
                  <td><span class="painel-badge painel-badge-ok">sonda</span></td>
                </tr>
              `)}
            </tbody>
          </table>
        `}
      </${Card}>
    </div>
  `;
}
