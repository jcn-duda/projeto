import { json } from './common.js';
import { apiBaseFromEnv } from './api-base.js';

const API = 'https://debrid-link.com/api/v2';

/**
 * @param {string} apiKey
 * @param {string} path
 * @param {object} [options]
 * @param {string} [options.method]
 * @param {*} [options.body]
 * @param {Object} [options.params]
 */
export async function call(apiKey: string, path: string, { method = 'GET', body, params = {} }: { method?: string; body?: BodyInit | null; params?: Record<string, string> } = {}) {
  const url = new URL(`${apiBaseFromEnv('DEBRIDLINK_API_BASE', API)}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const data = await json(url, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    body,
  });
  if (data.success === false) {
    throw new Error(data.error || 'debrid-link retornou erro');
  }
  return data.value;
}

export const id = 'debridlink';
export const label = 'Debrid-Link';
export const short = 'DL';
export const cacheCheck = false;
export const autofetchSource = true;
export const keyUrl = 'https://debrid-link.com/webapp/apikey';
