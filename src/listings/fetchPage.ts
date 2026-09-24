// Fetches the publicly visible text of a listing page. Fails gracefully - many property sites
// need a login, render with JavaScript, or block bots. In that case the user can paste the text.
import { isPublicHostname } from './url';

export type PageResult = { ok: true; text: string } | { ok: false; reason: string };

const TIMEOUT_MS = 8000;
const MAX_BYTES = 2_000_000;
const MAX_TEXT_CHARS = 15_000;
const MIN_USEFUL_CHARS = 300;

export async function fetchListingText(rawUrl: string): Promise<PageResult> {
  let url = new URL(rawUrl);
  let response: Response | null = null;

  try {
    // Follow redirects by hand so every hop is re-checked against private addresses.
    for (let hop = 0; hop < 4; hop++) {
      if (!isPublicHostname(url.hostname)) return { ok: false, reason: 'the link points to a private address' };
      response = await fetch(url, {
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { 'user-agent': 'Mozilla/5.0 (compatible; FlatDeciderBot/1.0)', accept: 'text/html,text/plain' },
      });
      const location = response.headers.get('location');
      if (response.status >= 300 && response.status < 400 && location) {
        url = new URL(location, url);
        continue;
      }
      break;
    }
  } catch {
    return { ok: false, reason: 'the site did not respond' };
  }

  if (!response) return { ok: false, reason: 'the site did not respond' };
  if (response.status === 401 || response.status === 403) return { ok: false, reason: 'the site requires a login or blocks automated access' };
  if (response.status === 404 || response.status === 410) return { ok: false, reason: 'the listing may have expired' };
  if (!response.ok) return { ok: false, reason: `the site returned an error (${response.status})` };

  const contentType = response.headers.get('content-type') ?? '';
  if (!/html|text/i.test(contentType)) return { ok: false, reason: 'the link is not a web page' };

  const buffer = await response.arrayBuffer().catch(() => null);
  if (!buffer) return { ok: false, reason: 'the page could not be downloaded' };
  const html = new TextDecoder().decode(buffer.slice(0, MAX_BYTES));

  const text = htmlToText(html);
  if (text.length < MIN_USEFUL_CHARS) {
    return { ok: false, reason: 'the page had almost no readable text (it may need JavaScript or a login)' };
  }
  return { ok: true, text: text.slice(0, MAX_TEXT_CHARS) };
}

/** Keeps the title, meta descriptions, JSON-LD data and visible text. Drops scripts, styles and markup. */
export function htmlToText(html: string): string {
  const parts: string[] = [];

  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  if (title) parts.push(`Title: ${title}`);

  for (const meta of html.matchAll(/<meta[^>]+(?:name|property)=["'](description|og:title|og:description)["'][^>]*>/gi)) {
    const content = meta[0].match(/content=["']([^"']*)["']/i)?.[1];
    if (content) parts.push(content);
  }

  // Structured data (schema.org) often holds price, rooms and address.
  for (const block of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    parts.push(block[1].slice(0, 4000));
  }

  const body = html
    .replace(/<(script|style|noscript|svg|head)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h\d|\/tr)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  parts.push(body);

  return decodeEntities(parts.join('\n'))
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function decodeEntities(text: string): string {
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rupee: '₹' };
  return text
    .replace(/&#(\d+);/g, (_, n) => codePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => codePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, name) => named[name.toLowerCase()] ?? m);
}

function codePoint(n: number): string {
  return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : ' ';
}
