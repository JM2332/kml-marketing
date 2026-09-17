/* Cloud Function: scanEmail
   Given a business website URL, fetches the homepage (and a couple of likely contact
   pages) server-side — avoids the browser CORS restrictions that block this from the
   client — and extracts a generic contact email address (mailto: links first, then
   visible text, preferring generic prefixes like info@/contact@ over a named person's
   address). Requires a valid Firebase ID token so only signed-in app users can invoke it
   (this fetches arbitrary attacker-suppliable URLs, so it must not be an open proxy). */

const functions = require('firebase-functions');
const admin = require('firebase-admin');
admin.initializeApp();

const ALLOWED_ORIGINS = new Set([
  'https://kml-marketing.web.app',
  'https://kml-marketing.firebaseapp.com',
  'http://localhost:5000',
  'http://127.0.0.1:5000',
]);

const GENERIC_PREFIXES = [
  'info', 'hello', 'contact', 'enquiries', 'enquiry', 'inquiries', 'bookings', 'booking',
  'reservations', 'reservation', 'admin', 'mail', 'sales', 'office', 'events', 'catering',
];

const CONTACT_PATHS = ['/contact', '/contact-us', '/contactus', '/contact.html'];

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const MAILTO_RE = /mailto:([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/gi;

const EXCLUDE_DOMAIN_SUBSTRINGS = [
  'sentry.io', 'wixpress.com', 'godaddy.com', 'example.com', 'schema.org', 'w3.org',
  'cloudflare.com', 'google.com', 'gstatic.com', 'facebook.com', 'instagram.com',
];

function isPrivateHost(hostname) {
  const h = hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.local')) return true;
  const ipMatch = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipMatch) {
    const [a, b] = ipMatch.slice(1, 3).map(Number);
    if (a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a === 169) return true;
  }
  return false;
}

function extractEmails(html) {
  const found = new Set();
  let m;
  MAILTO_RE.lastIndex = 0;
  while ((m = MAILTO_RE.exec(html))) found.add(m[1].toLowerCase());
  const textOnly = html.replace(/<[^>]*>/g, ' ');
  EMAIL_RE.lastIndex = 0;
  while ((m = EMAIL_RE.exec(textOnly))) found.add(m[0].toLowerCase());
  return Array.from(found).filter(e => {
    if (EXCLUDE_DOMAIN_SUBSTRINGS.some(d => e.endsWith('@' + d) || e.includes('.' + d))) return false;
    if (/\.(png|jpg|jpeg|gif|svg|webp)$/i.test(e)) return false;
    return true;
  });
}

function pickBest(emails) {
  if (!emails.length) return null;
  for (const prefix of GENERIC_PREFIXES) {
    const hit = emails.find(e => e.split('@')[0] === prefix);
    if (hit) return hit;
  }
  // fall back to any address whose local part looks generic-ish (no dot, i.e. not firstname.lastname)
  const generic = emails.find(e => !e.split('@')[0].includes('.'));
  return generic || emails[0];
}

async function fetchPage(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; KMLMarketingBot/1.0)' },
    });
    if (!res.ok) return '';
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('text/html')) return '';
    return await res.text();
  } catch (e) {
    return '';
  } finally {
    clearTimeout(timer);
  }
}

exports.scanEmail = functions.https.onRequest(async (req, res) => {
  const origin = req.get('Origin');
  if (origin && ALLOWED_ORIGINS.has(origin)) res.set('Access-Control-Allow-Origin', origin);
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }

  const authHeader = req.get('Authorization') || '';
  const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!idToken) { res.status(401).json({ error: 'Missing auth token' }); return; }
  try {
    await admin.auth().verifyIdToken(idToken);
  } catch (e) {
    res.status(401).json({ error: 'Invalid auth token' });
    return;
  }

  const rawUrl = (req.body && req.body.url || '').trim();
  let target;
  try {
    target = new URL(rawUrl);
  } catch (e) {
    res.status(400).json({ error: 'Invalid URL' });
    return;
  }
  if (!['http:', 'https:'].includes(target.protocol) || isPrivateHost(target.hostname)) {
    res.status(400).json({ error: 'URL not allowed' });
    return;
  }

  try {
    const homeHtml = await fetchPage(target.href);
    let emails = extractEmails(homeHtml);
    let source = homeHtml.includes('mailto:') && emails.length ? 'mailto' : (emails.length ? 'text' : '');
    let page = target.href;

    if (!emails.length) {
      for (const path of CONTACT_PATHS) {
        const contactUrl = new URL(path, target.origin).href;
        const html = await fetchPage(contactUrl);
        if (!html) continue;
        const found = extractEmails(html);
        if (found.length) { emails = found; source = 'contact-page'; page = contactUrl; break; }
      }
    }

    const best = pickBest(emails);
    if (!best) { res.status(200).json({ email: null }); return; }
    res.status(200).json({ email: best, source, page });
  } catch (e) {
    res.status(200).json({ email: null, error: e.message });
  }
});
