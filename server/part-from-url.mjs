// Read an electronic part's product page or datasheet and extract a spec the
// studio can turn into a wireable component.
//
//   POST /api/part-from-url { url }  →  { part, source, notes, datasheet, title }
//
// The page is fetched here (browsers can't read other sites' pages), stripped
// to text, and given to Claude with a JSON schema. A linked datasheet PDF is
// fetched and attached too. Without Anthropic credentials (ANTHROPIC_API_KEY,
// or an `ant auth login` profile) a regex parser makes a rough first guess.
import Anthropic from '@anthropic-ai/sdk';
import dns from 'node:dns/promises';
import net from 'node:net';

const MAX_BYTES = 15e6;
const MAX_TEXT = 180_000; // characters of page text sent to Claude
const KINDS = ['digital-in', 'digital-out', 'pwm', 'analog', 'spi-sck', 'spi-mosi', 'i2c-sda', 'i2c-scl', 'data'];
const IFACES = ['digital-in', 'digital-out', 'pwm', 'analog', 'i2c', 'spi', 'uart', 'ws2812', 'other'];
const SURFACES = ['none', 'button', 'knob', 'pot', 'indicator', 'display', 'sound', 'vents', 'wires'];
const CATEGORIES = ['input', 'output', 'display', 'sensor', 'actuator'];

// ---------------------------------------------------------------- safe fetch
// Private, loopback, link-local, carrier-NAT, documentation, multicast and reserved ranges.
const BLOCK = new net.BlockList();
for (const [a, n] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]]) BLOCK.addSubnet(a, n, 'ipv4');
for (const [a, n] of [['::', 96], ['::1', 128], ['64:ff9b::', 96], ['100::', 64], ['2001:db8::', 32], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8]]) BLOCK.addSubnet(a, n, 'ipv6');
export function privateIp(ip) {
  if (net.isIPv4(ip)) return BLOCK.check(ip, 'ipv4');
  if (!net.isIPv6(ip)) return true;
  let v; try { v = new URL(`http://[${ip}]`).hostname.slice(1, -1); } catch { return true; } // canonical form: ::ffff:7f00:1
  const m = v.match(/^::ffff:(?:0:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/); // IPv4-mapped (and -translated): check the IPv4 inside
  if (m) { const hi = parseInt(m[1], 16), lo = parseInt(m[2], 16); return BLOCK.check([hi >> 8, hi & 255, lo >> 8, lo & 255].join('.'), 'ipv4'); }
  return BLOCK.check(v, 'ipv6');
}
// FF_ALLOW_LOCAL_FETCH=1 is for the end-to-end tests only (they serve a fixture page on localhost).
const ALLOW_LOCAL = process.env.FF_ALLOW_LOCAL_FETCH === '1' && process.env.NODE_ENV !== 'production';
async function checkUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new Error('That is not a valid link.'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Only http(s) links are supported.');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (ALLOW_LOCAL) return u;
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) throw new Error('Links to this computer or the local network are not allowed.');
  const addrs = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true }).catch(() => { throw new Error(`Could not find ${host}.`); })).map(a => a.address);
  if (addrs.some(privateIp)) throw new Error('Links to this computer or the local network are not allowed.');
  return u;
}
async function get(url, redirects = 0) {
  const u = await checkUrl(url);
  const r = await fetch(u, {
    redirect: 'manual', signal: AbortSignal.timeout(20000),
    headers: { 'user-agent': 'Mozilla/5.0 (compatible; FormframePartReader/0.1)', accept: 'text/html,application/xhtml+xml,application/pdf;q=0.9,*/*;q=0.5' },
  });
  if (r.status >= 300 && r.status < 400 && r.headers.get('location')) {
    if (redirects > 4) throw new Error('Too many redirects.');
    return get(new URL(r.headers.get('location'), u).href, redirects + 1);
  }
  if (!r.ok) throw new Error(`That site wouldn't share the page (error ${r.status}).`);
  const len = +(r.headers.get('content-length') ?? 0);
  if (len > MAX_BYTES) throw new Error('That file is over 15 MB.');
  // read in chunks and stop at the limit (content-length can be missing or wrong)
  const chunks = []; let size = 0;
  for await (const c of r.body ?? []) {
    size += c.length;
    if (size > MAX_BYTES) { await r.body.cancel().catch(() => {}); throw new Error('That file is over 15 MB.'); }
    chunks.push(c);
  }
  const buf = Buffer.concat(chunks.map(c => Buffer.from(c)));
  const type = (r.headers.get('content-type') ?? '').toLowerCase();
  return { url: u.href, buf, pdf: type.includes('pdf') || buf.subarray(0, 5).toString() === '%PDF-', type };
}

// ---------------------------------------------------------------- html → text
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', deg: '°', micro: 'µ', plusmn: '±', times: '×', ohm: 'Ω', Omega: 'Ω', mu: 'µ' };
const decode = s => s.replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) => e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : +e.slice(1)) : ENT[e] ?? m);
export function htmlToText(html, base) {
  const title = decode((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '').trim());
  const meta = decode(decode(html.match(/<meta[^>]+(?:name|property)=["'](?:og:)?description["'][^>]+content=["']([^"']*)/i)?.[1] ?? '')).replace(/\u00a0/g, ' ');
  const links = [];
  for (const m of html.matchAll(/<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const text = decode(m[2].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
    if (/datasheet|\.pdf(\?|$)|data sheet|specification/i.test(m[1] + ' ' + text)) { try { links.push({ href: new URL(m[1], base).href, text }); } catch { } }
  }
  let t = html
    .replace(/<(script|style|noscript|svg|iframe|template)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(td|th)>/gi, ' | ').replace(/<\/(tr|li|p|div|h[1-6]|section|article|dt|dd)>/gi, '\n').replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  t = decode(t).replace(/[ \t\f\v]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return { title, meta, text: t, datasheets: [...new Map(links.map(l => [l.href, l])).values()].slice(0, 8) };
}

// ---------------------------------------------------------------- schema
const orNull = (t, extra = {}) => ({ ...extra, anyOf: [t, { type: 'null' }] });
const num = orNull({ type: 'number' });
const str = (description) => orNull({ type: 'string' }, description ? { description } : {});
const SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['name', 'manufacturer', 'partNumber', 'category', 'interface', 'summary', 'uses', 'requirements', 'pins', 'supplyMinV', 'supplyMaxV', 'logicV', 'rail', 'typicalmA', 'peakmA', 'i2cAddress', 'activeLow', 'priceUSD', 'sizeMm', 'surface', 'confidence', 'missing'],
  properties: {
    name: { type: 'string', description: 'Short human name, e.g. "BME280 temp/humidity/pressure sensor"' },
    manufacturer: str(),
    partNumber: str(),
    category: { type: 'string', enum: CATEGORIES },
    interface: { type: 'string', enum: IFACES, description: 'Main way a microcontroller talks to it' },
    summary: { type: 'string', description: 'One or two sentences: what it is and what it does' },
    uses: { type: 'array', items: { type: 'string' }, description: 'Typical uses in a product, short phrases' },
    requirements: { type: 'array', items: { type: 'string' }, description: 'Wiring/electrical requirements a designer must meet: pull-ups, level shifting, separate supply, decoupling, minimum current, warm-up time…' },
    pins: {
      type: 'array', description: 'Signal pins that connect to microcontroller GPIOs. Exclude VCC/VIN/GND/NC. Kinds are from the microcontroller side: a sensor output the MCU reads is digital-in; a pin the MCU drives (CS, DC, EN, RX of the part) is digital-out.',
      items: { type: 'object', additionalProperties: false, required: ['id', 'kind', 'description'], properties: { id: { type: 'string', description: 'Silkscreen label, max 6 chars' }, kind: { type: 'string', enum: KINDS }, description: { type: 'string' } } },
    },
    supplyMinV: num, supplyMaxV: num,
    logicV: orNull({ type: 'number', enum: [3.3, 5] }, { description: 'Logic level its signal pins use or tolerate (3.3 or 5)' }),
    rail: orNull({ type: 'string', enum: ['3v3', '5v'] }, { description: 'Which dev-board rail should power it' }),
    typicalmA: num, peakmA: num,
    i2cAddress: str('Default 7-bit I2C address as hex like "0x76", if I2C'),
    activeLow: orNull({ type: 'boolean' }, { description: 'For digital inputs: true if the signal goes LOW when active (e.g. a button to GND)' }),
    priceUSD: num,
    sizeMm: orNull({ type: 'object', additionalProperties: false, required: ['w', 'h', 'd'], properties: { w: { type: 'number' }, h: { type: 'number' }, d: { type: 'number' } } }, { description: 'Module/board outline: width, height (in the board plane) and thickness including parts' }),
    surface: { type: 'string', enum: SURFACES, description: 'What it needs on the product enclosure: button cap, knob, pot knob, indicator lens, display window, sound holes, vents (sensors that need air), wires (terminal entry), or none' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    missing: { type: 'array', items: { type: 'string' }, description: 'Specs you could not find on the page' },
  },
};
const SYSTEM = `You read electronics product pages and datasheets and extract the facts a product designer needs to prototype with the part on a microcontroller dev board (Raspberry Pi Pico, Arduino Uno, ESP32, Raspberry Pi).
Only report what the page or datasheet supports; use null and list the field under "missing" when a value isn't given. Prefer the breakout/module numbers over the bare chip when the link is a module. Pin labels should match the module's silkscreen.`;

// ---------------------------------------------------------------- extraction
async function withClaude(page, pdfs, apiKey) {
  const client = new Anthropic(apiKey ? { apiKey } : undefined);
  const content = [];
  for (const p of pdfs) content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: p.buf.toString('base64') }, title: p.url });
  let text = page?.text ?? '', truncated = false;
  if (text.length > MAX_TEXT) { text = text.slice(0, MAX_TEXT); truncated = true; }
  if (page) content.push({ type: 'text', text: `Product page: ${page.url}\nTitle: ${page.title}\nDescription: ${page.meta}\n${page.datasheets.length ? 'Datasheet links: ' + page.datasheets.map(d => d.href).join(', ') + '\n' : ''}${truncated ? `(The page text was ${page.text.length.toLocaleString()} characters; only the first ${MAX_TEXT.toLocaleString()} are included.)\n` : ''}\n<page>\n${text}\n</page>` });
  content.push({ type: 'text', text: 'Extract this part\'s spec.' });
  const res = await client.beta.messages.create({
    model: 'claude-opus-5-5',
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } },
    system: SYSTEM,
    messages: [{ role: 'user', content }],
  });
  if (res.stop_reason === 'refusal') throw Object.assign(new Error('Claude declined to read this page.'), { refusal: true });
  if (res.stop_reason === 'max_tokens') throw new Error('The reply was cut off. Try the datasheet link directly.');
  const out = res.content.find(b => b.type === 'text')?.text;
  if (!out) throw new Error('No spec came back.');
  return { part: JSON.parse(out), truncated, model: res.model };
}

/** Rough regex fallback when Claude isn't available. */
export function heuristic(page) {
  const t = `${page.title}\n${page.meta}\n${page.text}`;
  const has = re => re.test(t);
  const iface = has(/\bI\s?[²2]\s?C\b|\bIIC\b|\bTWI\b/i) ? 'i2c' : has(/\bSPI\b/) ? 'spi' : has(/\bWS281[12]|NeoPixel/i) ? 'ws2812' : has(/\bUART\b|\bserial\b/i) ? 'uart' : has(/\banalog (output|signal)|\bADC\b/i) ? 'analog' : has(/\bPWM\b/) ? 'pwm' : 'digital-in';
  const pins = { i2c: [['SDA', 'i2c-sda'], ['SCL', 'i2c-scl']], spi: [['SCK', 'spi-sck'], ['MOSI', 'spi-mosi'], ['MISO', 'digital-in'], ['CS', 'digital-out']], ws2812: [['DIN', 'data']], uart: [['TX', 'digital-in'], ['RX', 'digital-out']], analog: [['OUT', 'analog']], pwm: [['PWM', 'pwm']], 'digital-in': [['OUT', 'digital-in']] }[iface];
  const volts = [...t.matchAll(/(\d(?:\.\d)?)\s?V\b/g)].map(m => +m[1]).filter(v => v >= 1.8 && v <= 24);
  const mA = [...t.matchAll(/(\d+(?:\.\d+)?)\s?mA\b/g)].map(m => +m[1]);
  const addr = t.match(/\b0x([0-7][0-9a-f])\b/i)?.[0] ?? null;
  const dims = t.match(/(\d+(?:\.\d+)?)\s?(?:mm)?\s?[x×]\s?(\d+(?:\.\d+)?)\s?(?:mm)?(?:\s?[x×]\s?(\d+(?:\.\d+)?))?\s?mm/i);
  const price = t.match(/\$\s?(\d+(?:\.\d{2})?)/);
  let name = (page.title || 'Imported part').split(/\s[|:–—-]\s/)[0].replace(/\[[^\]]*\]/g, '').trim();
  if (name.length > 60) name = name.slice(0, 60).replace(/\s+\S*$/, '');
  const sensor = has(/sensor|temperature|humidity|pressure|accelerometer|gyro|light|distance|gas/i);
  return {
    name, manufacturer: null, partNumber: null,
    category: sensor ? 'sensor' : iface === 'digital-in' ? 'input' : 'output', interface: iface,
    summary: page.meta || `Imported from ${new URL(page.url).hostname}.`, uses: [], requirements: [],
    pins: pins.map(([id, kind]) => ({ id, kind, description: '' })),
    supplyMinV: volts.length ? Math.min(...volts) : null, supplyMaxV: volts.length ? Math.max(...volts) : null,
    logicV: volts.includes(5) && !volts.includes(3.3) ? 5 : 3.3, rail: volts.some(v => v <= 3.6) ? '3v3' : '5v',
    typicalmA: mA.length ? Math.min(...mA) : null, peakmA: mA.length ? Math.max(...mA) : null,
    i2cAddress: iface === 'i2c' ? addr : null, activeLow: null, priceUSD: price ? +price[1] : null,
    sizeMm: dims ? { w: +dims[1], h: +dims[2], d: dims[3] ? +dims[3] : 3 } : null,
    surface: sensor ? 'vents' : 'none', confidence: 'low',
    missing: ['Read without AI: check every value'],
  };
}

/** apiKey: a visitor's own key (aikey.mjs), or undefined for the site's key. */
export async function partFromUrl(url, apiKey) {
  const first = await get(url);
  const notes = [];
  let page = null; const pdfs = [];
  if (first.pdf) pdfs.push(first);
  else {
    page = { url: first.url, ...htmlToText(first.buf.toString('utf8'), first.url) };
    const ds = page.datasheets.find(d => /\.pdf(\?|$)/i.test(d.href)) ?? page.datasheets[0];
    if (ds) {
      try { const d = await get(ds.href); if (d.pdf) { pdfs.push(d); notes.push(`Also read the datasheet: ${ds.href}`); } }
      catch (e) { notes.push(`Couldn't open the linked datasheet (${e.message}).`); }
    }
    if (!page.text && !pdfs.length) throw new Error('The page had no readable text. It may need JavaScript; try the datasheet PDF link instead.');
  }
  const datasheet = pdfs[0]?.url ?? null, title = page?.title ?? '';
  try {
    const r = await withClaude(page, pdfs, apiKey);
    if (r.truncated) notes.push('The page was very long, so only the first part of it was read.');
    return { part: r.part, source: 'claude', model: r.model, notes, datasheet, title, url: first.url };
  } catch (e) {
    if (e?.refusal) throw e;
    const auth = e instanceof Anthropic.AuthenticationError || /api key|authentication|credentials|apiKey/i.test(e?.message ?? '');
    if (!page) throw new Error(auth ? (apiKey ? 'Anthropic rejected your API key, so the PDF couldn’t be read.' : 'Reading a PDF needs Claude: set ANTHROPIC_API_KEY (or run `ant auth login`) and restart `npm run dev`.') : `Couldn't read the datasheet: ${e.message}`);
    notes.push(auth ? (apiKey ? 'Anthropic rejected your API key, so this is a rough guess from the page text. Add it again from the Project menu (Claude API key).' : 'No Anthropic credentials, so this is a rough guess from the page text. Set ANTHROPIC_API_KEY (or run `ant auth login`) and restart `npm run dev` for a proper read.') : `Claude couldn't read it (${e.message}), so this is a rough guess from the page text.`);
    return { part: heuristic(page), source: 'heuristic', notes, datasheet, title, url: first.url };
  }
}
