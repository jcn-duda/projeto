import { html, useState } from './vendor/preact.js';
import { Card } from './kit.js';

export interface AppProps {
  token?: string;
}

export function App(props: AppProps) {
  const [token, setToken] = useState(props.token || (typeof localStorage !== 'undefined' ? localStorage.getItem('dash_token') || '' : ''));
  const [activeTab, setActiveTab] = useState('saude');

  const onSaveToken = () => {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('dash_token', token);
    }
  };

  return html`
    <div class="painel-shell">
      <header class="painel-header">
        <div class="painel-brand">
          <img class="painel-logo" src="/logo.png" alt="Adom Logo" />
          <h1 class="painel-title">Adom Power-Movie</h1>
        </div>
        <div class="painel-controls">
          <input
            type="password"
            class="painel-token-input"
            placeholder="Token operador..."
            value=${token}
            onInput=${(e: any) => setToken(e.target.value)}
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
      </nav>

      <main class="painel-content">
        ${!token ? html`
          <div class="painel-empty">
            <h2>Nenhum token configurado</h2>
            <p>Insira o token de diagnóstico no cabeçalho para carregar o status em tempo real.</p>
          </div>
        ` : html`
          <div class="painel-grid">
            <${Card} title="Status Geral">
              <p>Painel operacional carregado com sucesso.</p>
            </${Card}>
          </div>
        `}
      </main>
    </div>
  `;
}
