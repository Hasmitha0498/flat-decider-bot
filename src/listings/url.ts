// URL validation and normalisation (pure, unit tested).

const TRACKING_PARAMS = /^(utm_|fbclid$|gclid$|ref$|ref_src$|source$|share|si$)/i;

/** Returns a parsed http(s) URL, or null if the text is not a usable public URL. */
export function parseListingUrl(text: string): URL | null {
  const match = text.trim().match(/https?:\/\/\S+/i);
  if (!match) return null;
  let url: URL;
  try {
    url = new URL(match[0]);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (!isPublicHostname(url.hostname)) return null;
  return url;
}

/** Blocks localhost / private network addresses so users can't make the server fetch internal URLs. */
export function isPublicHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host.includes('.') && !host.includes(':')) return false; // "localhost", intranet names
  if (host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return false;

  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    if (a === 10 || a === 127 || a === 0 || a >= 224) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
  }
  if (host.includes(':')) {
    // IPv6 literal: allow only global unicast-looking addresses
    if (host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80') || host.startsWith('::')) return false;
  }
  return true;
}

/** Same flat, same key: lowercase host, no "www.", no tracking params, no fragment, no trailing slash. */
export function normalizeUrl(url: URL): string {
  const copy = new URL(url.toString());
  copy.hash = '';
  copy.hostname = copy.hostname.toLowerCase().replace(/^www\./, '');
  copy.protocol = 'https:';
  for (const key of [...copy.searchParams.keys()]) {
    if (TRACKING_PARAMS.test(key)) copy.searchParams.delete(key);
  }
  copy.searchParams.sort();
  let normalized = copy.toString();
  if (normalized.endsWith('/')) normalized = normalized.slice(0, -1);
  return normalized;
}
