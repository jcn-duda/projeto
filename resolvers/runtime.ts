const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122 Safari/537.36';

function trimUrl(value: unknown): string {
  return String(value || '').replace(/\/$/, '');
}

function parseHost(urlString: string): string {
  try {
    return new URL(urlString).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function parseExtraProtectors(envVal: string | null | undefined): string[] {
  if (!envVal || !String(envVal).trim()) return [];
  return String(envVal).split(',').map((value) => value.trim().toLowerCase()).filter(Boolean);
}

export { USER_AGENT, trimUrl, parseHost, parseExtraProtectors };
