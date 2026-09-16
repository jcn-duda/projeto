import { html, useState, useEffect } from './vendor/preact.js';
import {
  getPainelState,
  subscribePainelState,
  setPainelToken,
  type PainelState,
} from './store.js';
import { startPolling } from './poll.js';
import { ViewSaude } from './view-saude.js';
import { ViewConta } from './view-conta.js';
import { ViewGate } from './view-gate.js';
import { ViewColhedor } from './view-colhedor.js';
import { ViewSonda } from './view-sonda.js';
import { ViewChupim } from './view-chupim.js';
import { ViewCache } from './view-cache.js';
import { ViewLimpeza } from './view-limpeza.js';
import { ViewMagnets } from './view-magnets.js';

export interface AppProps {
  initialTab?: string;
}

export function App(props: AppProps) {
  const [appState, setAppState] = useState<PainelState>(getPainelState());
  const [tokenInput, setTokenInput] = useState(appState.token);
  const [activeTab, setActiveTab] = useState(props.initialTab || 'saude');

  useEffect(() => {
    const unsubscribe = subscribePainelState((next) => {
      setAppState(next);
      setTokenInput(next.token);
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (!appState.token) return;
    const stop = startPolling();
    return stop;
  }, [appState.token, appState.refreshRateS]);

  const onSaveToken = () => {
    setPainelToken(tokenInput.trim());
  };

  const p = appState.payload || {};

  return html`
    <div class="painel-shell">
      <header class="painel-header">
        <div class="painel-brand">
          <img class="painel-logo" src="/logo.png" alt="Adom Logo" />
          <h1 class="painel-title">Adom Power-Movie</h1>
          <span class="painel-badge ${appState.connectionState === 'online' ? 'painel-badge-ok' : appState.connectionState === 'error' ? 'painel-badge-err' : 'painel-badge-neutral'}">
            ${appState.loading ? 'SINCRONIZANDO...' : appState.connectionState.toUpperCase()}
          </span>
        </div>
        <div class="painel-controls">
          <input
            type="password"
            class="painel-token-input"
            placeholder="Token operador..."
            value=${tokenInput}
            onInput=${(e: any) => setTokenInput(e.target.value)}
          />
          <button class="painel-btn painel-btn-accent" onClick=${onSaveToken}>Salvar</button>
        </div>
      </header>

      <nav class="painel-tabs">
        <button
          class=${'painel-tab-btn' + (activeTab === 'saude' ? ' active' : '')}
          onClick=${() => setActiveTab('saude')}
        >
          Saúde
        </button>
        <button
          class=${'painel-tab-btn' + (activeTab === 'conta' ? ' active' : '')}
          onClick=${() => setActiveTab('conta')}
        >
          Conta Debrid
        </button>
        <button
          class=${'painel-tab-btn' + (activeTab === 'gate' ? ' active' : '')}
          onClick=${() => setActiveTab('gate')}
        >
          Gate
        </button>
        <button
          class=${'painel-tab-btn' + (activeTab === 'colhedor' ? ' active' : '')}
          onClick=${() => setActiveTab('colhedor')}
        >
          Colhedor
        </button>
        <button
          class=${'painel-tab-btn' + (activeTab === 'sonda' ? ' active' : '')}
          onClick=${() => setActiveTab('sonda')}
        >
          Sonda BR
        </button>
        <button
          class=${'painel-tab-btn' + (activeTab === 'chupim' ? ' active' : '')}
          onClick=${() => setActiveTab('chupim')}
        >
          Chupim
        </button>
        <button
          class=${'painel-tab-btn' + (activeTab === 'cache' ? ' active' : '')}
          onClick=${() => setActiveTab('cache')}
        >
          Cache
        </button>
        <button
          class=${'painel-tab-btn' + (activeTab === 'limpeza' ? ' active' : '')}
          onClick=${() => setActiveTab('limpeza')}
        >
          Limpeza
        </button>
        <button
          class=${'painel-tab-btn' + (activeTab === 'magnets' ? ' active' : '')}
          onClick=${() => setActiveTab('magnets')}
        >
          Magnets
        </button>
      </nav>

      <main class="painel-content">
        ${!appState.token ? html`
          <div class="painel-empty">
            <h2>Nenhum token configurado</h2>
            <p>Insira o token de diagnóstico no cabeçalho para carregar o status em tempo real.</p>
          </div>
        ` : appState.error ? html`
          <div class="painel-empty" style="border-color: var(--red);">
            <h2 style="color: var(--red);">Falha ao carregar dados</h2>
            <p>${appState.error}</p>
          </div>
        ` : html`
          ${activeTab === 'saude' ? html`
            <${ViewSaude}
              general=${p.general}
              debrid=${p.debrid}
              conta=${p.conta}
              searchFirst=${p.searchFirst}
            />
          ` : activeTab === 'conta' ? html`
            <${ViewConta} conta=${p.conta} debrid=${p.debrid} />
          ` : activeTab === 'gate' ? html`
            <${ViewGate} gate=${p.gate} />
          ` : activeTab === 'colhedor' ? html`
            <${ViewColhedor} harvest=${p.harvest} metrics=${p.metrics} />
          ` : activeTab === 'sonda' ? html`
            <${ViewSonda} harvest=${p.harvest} f3=${p.f3} metrics=${p.metrics} />
          ` : activeTab === 'chupim' ? html`
            <${ViewChupim} autofetch=${p.autofetch} metrics=${p.metrics} />
          ` : activeTab === 'cache' ? html`
            <${ViewCache} cache=${p.cache} metrics=${p.metrics} />
          ` : activeTab === 'limpeza' ? html`
            <${ViewLimpeza} catalog=${p.catalog} conta=${p.conta} />
          ` : activeTab === 'magnets' ? html`
            <${ViewMagnets} magnetdb=${p.magnetdb} />
          ` : null}
        `}
      </main>
    </div>
  `;
}

