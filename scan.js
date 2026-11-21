'use strict';
// AK Trading AI — server-side scanner (runs in GitHub Actions, no VPS needed).
// Reads config.json, analyzes markets, sends Telegram signals, tracks outcomes in data/journal.json.
const fs = require('fs');
const path = require('path');
const { SYMS, HTF, TFMS, analyze, evalEntry, calcStats, sigText } = require('../engine.js');

const ROOT = path.join(__dirname, '..');
const JP = path.join(ROOT, 'data', 'journal.json');
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const TG_TOKEN = (process.env.TG_TOKEN || '').trim();
const TG_CHAT = (process.env.TG_CHAT || '').trim();
const TD_KEY = (process.env.TD_KEY || '').trim();
const TDI = { '5m': '5min', '15m': '15min', '1h': '1h', '4h': '4h', '1d': '1day' };
const OKX = { '5m': '5m', '15m': '15m', '1h': '1H', '4h': '4H', '1d': '1D' };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getJSON(u) {
  const r = await fetch(u, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}
async function crypto_(sym, tf) {
  const errs = [];
  for (const h of ['https://data-api.binance.vision', 'https://api.binance.com']) {
    try {
      const d = await getJSON(`${h}/api/v3/klines?symbol=${sym}&interval=${tf}&limit=300`);
      return { c: d.map(k => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5], tb: +k[9] })), src: 'Binance' };
    } catch (e) { errs.push(e.message); }
  }
  try { // fallback: OKX (no taker-buy volume -> Delta is approximated)
    const inst = sym.replace(/USDT$/, '-USDT');
    const d = await getJSON(`https://www.okx.com/api/v5/market/candles?instId=${inst}&bar=${OKX[tf]}&limit=300`);
    if (!d.data || !d.data.length) throw new Error('OKX бос жауап');
    return { c: d.data.reverse().map(k => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5], tb: null })), src: 'OKX' };
  } catch (e) { errs.push('OKX ' + e.message); }
  throw new Error('Крипто дерегі алынбады: ' + errs.join('; '));
}
let tdLast = 0;
async function twelve(sym, tf) {
  const w = tdLast + 7700 - Date.now();
  if (w > 0) await sleep(w);
  tdLast = Date.now();
  const d = await getJSON(`https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(sym)}&interval=${TDI[tf]}&outputsize=300&timezone=UTC&apikey=${TD_KEY}`);
  if (d.status === 'error' || !d.values) throw new Error(d.message || 'Twelve Data қатесі');
  return { c: d.values.reverse().map(x => ({ t: Date.parse(x.datetime.replace(' ', 'T') + 'Z'), o: +x.open, h: +x.high, l: +x.low, c: +x.close, v: +(x.volume || 0), tb: null })), src: 'Twelve Data' };
}
async function candles(name, tf) {
  const s = SYMS[name];
  if (s.kind === 'crypto') return crypto_(s.bn, tf);
  if (TD_KEY) return twelve(s.td, tf);
  if (s.kind === 'gold') return { ...(await crypto_(s.bn, tf)), proxy: true };
  throw new Error('Forex үшін TD_KEY secret керек');
}
const cache = new Map();
function cget(name, tf) {
  const k = name + '|' + tf;
  if (!cache.has(k)) { const p = candles(name, tf); cache.set(k, p); p.catch(() => cache.delete(k)); }
  return cache.get(k);
}

async function tg(text) {
  if (!TG_TOKEN || !TG_CHAT) { console.log('[telegram өшірулі: TG_TOKEN/TG_CHAT жоқ]'); return false; }
  try {
    const r = await fetch('https://api.telegram.org/bot' + TG_TOKEN + '/sendMessage', { method: 'POST', body: new URLSearchParams({ chat_id: TG_CHAT, text }) });
    const j = await r.json();
    if (!j.ok) console.log('Telegram қатесі:', j.description);
    return !!j.ok;
  } catch (e) { console.log('Telegram қатесі:', e.message); return false; }
}
const statLine = J => { const s = calcStats(J); return `📊 Жабық ${s.w + s.l}: ${s.w} профит / ${s.l} минус · Winrate ${s.wr.toFixed(0)}% · Net ${s.R > 0 ? '+' : ''}${s.R.toFixed(2)}R`; };

async function notifyChange(e, before, J) {
  let t = '';
  if (e.st === 'WIN') t = `✅ PROFIT · ${e.name} ${e.tf} ${e.sig}\nTP1 алынды: +${(+e.rr).toFixed(2)}R\n\n${statLine(J)}`;
  else if (e.st === 'LOSS') t = `❌ LOSS · ${e.name} ${e.tf} ${e.sig}\nStop Loss: −1R\n\n${statLine(J)}`;
  else if (before === 'PENDING' && e.st === 'OPEN') t = `📍 Entry алынды · ${e.name} ${e.tf} ${e.sig}\nEntry: ${(+e.entry).toFixed(e.d)}`;
  if (t) await tg(t);
}

function record(J, name, tf, r, src) {
  const now = Date.now();
  if (J.some(e => e.name === name && e.tf === tf && e.sig === r.sig && (e.st === 'PENDING' || e.st === 'OPEN' || now - e.t < 4 * 36e5))) return null;
  const dir = r.sig === 'BUY' ? 1 : -1;
  const top = r.reasons.filter(x => x.s !== 0 && Math.sign(x.s) === dir).sort((a, b) => Math.abs(b.s) - Math.abs(a.s)).slice(0, 3).map(x => x.t);
  const e = { id: now + '-' + Math.random().toString(36).slice(2, 6), t: now, name, tf, sig: r.sig, type: r.plan.type, entry: r.plan.entry, sl: r.plan.sl, tp1: r.plan.tp1, tp2: r.plan.tp2, rr: r.plan.rr, score: r.score, d: r.dec, src, top, st: r.plan.type === 'LIMIT' ? 'PENDING' : 'OPEN', R: 0 };
  J.push(e);
  return e;
}

(async () => {
  let raw = '[]';
  try { raw = fs.readFileSync(JP, 'utf8'); } catch (e) { /* first run */ }
  const J = JSON.parse(raw || '[]');
  const watch = (CFG.watch || []).filter(n => SYMS[n]);
  const tfs = (CFG.tfs || ['15m']).filter(t => TFMS[t] && HTF[t]);
  let ns = 0, ok = 0, errs = 0, closed = 0;
  const msgs = [];

  // 1) update open signals
  for (const e of J.filter(e => e.st === 'PENDING' || e.st === 'OPEN')) {
    try {
      const L = await cget(e.name, e.tf), before = e.st;
      evalEntry(e, L.c);
      if (e.st !== before) { console.log(`${e.name} ${e.tf}: ${before} -> ${e.st}`); await notifyChange(e, before, J); }
    } catch (err) { errs++; msgs.push(`${e.name}: ${err.message}`); }
  }

  // 2) scan watchlist
  for (const name of watch) for (const tf of tfs) {
    try {
      const L = await cget(name, tf);
      let htf = L.c;
      try { htf = (await cget(name, HTF[tf])).c; } catch (e) { /* fallback to LTF */ }
      if (L.c.length < 80) throw new Error('Дерек жеткіліксіз');
      ok++;
      if (SYMS[name].kind !== 'crypto' && !L.proxy && Date.now() - L.c[L.c.length - 1].t > 3 * TFMS[tf]) { closed++; console.log(`${name} ${tf}: нарық жабық`); continue; }
      const r = analyze(L.c, htf, name, tf);
      console.log(`${name} ${tf}: ${r.sig} (score ${r.score})`);
      if (r.sig !== 'WAIT' && r.plan) {
        const e = record(J, name, tf, r, L.src + (L.proxy ? ' (proxy)' : ''));
        if (e) { ns++; await tg(sigText(e)); }
      }
    } catch (err) { errs++; msgs.push(`${name} ${tf}: ${err.message}`); console.log(`${name} ${tf}: қате — ${err.message}`); }
  }

  // 3) daily summary at 08:00 Tashkent (03:00 UTC)
  const now = new Date();
  if (now.getUTCHours() === 3 && now.getUTCMinutes() < 15 && J.length) await tg(`🗓 Күнделікті есеп\n${statLine(J)}\nАшық: ${calcStats(J).o}`);

  fs.mkdirSync(path.dirname(JP), { recursive: true });
  const out = JSON.stringify(J.slice(-500), null, 1) + '\n';
  if (out !== raw) fs.writeFileSync(JP, out);
  console.log(`Бітті: ${ns} жаңа сигнал, ${ok} талданды, ${closed} жабық, ${errs} қате`);
  msgs.forEach(m => console.log(' !', m));
  if (!ok && errs) process.exitCode = 1; // nothing worked -> show red X in Actions
})();
