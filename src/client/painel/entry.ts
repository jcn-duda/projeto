import { render, html } from './vendor/preact.js';
import { App } from './app.js';

export function bootstrap() {
  const container = document.getElementById('app');
  if (!container) return;
  render(html`<${App} />`, container);
}

if (typeof document !== 'undefined') {
  bootstrap();
}
