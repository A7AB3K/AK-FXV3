'use strict';
// AK Trading AI — London range breakout backtest (XAU/USD, 15m and 1H).
// Rule (from the user's TradingView indicator): London session (07:00-16:00 UTC) high/low lines.
// A candle crossing a line = entry. Entry windows: NY (same day 16:00-22:00 UTC),
// next-day London (07:00-13:00 UTC), or both. TP = 100 pips, SL is searched by the backtest.
// Chronological 70/30 train/test split, spread cost included.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let CFG = {};
try { CFG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')); } catch (e) { /* tests */ }
const SB = CFG.sessionBacktest || {};
const SYMBOL = SB.symbol || 'XAU/USD';
const TFS = SB.tfs || ['15m', '1h'];
const PIP = SB.pip || 0.1;                       // USD per pip (gold: 1 pip = $0.10 -> 100 pips = $10)
const COST = SB.cost != null ? SB.cost : 0.3;    // round-trip spread/commission, USD per oz
const CANDLES = SB.candles || { '15m': 20000, '1h': 5000 };
const LON = SB.london || [7, 16];
const NYW = [16, 22];                            // NY window after London range is complete
const LONW = [7, 13];                            // next-day London window (lines expire at next NY open)
const KEY = (process.env.TD_KEY || '').trim();
const TG_TOKEN = (process.env.TG_TOKEN || '').trim();
const TG_CHAT = (process.env.TG_CHAT || '').trim();
const TFH = { '15m': 0.25, '1h': 1 };
const TDI = { '15m': '15min', '1h': '1h' };
const DEADLINE_H = 12;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getJSON(u) {
  const r = await fetch(u, { signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}
const fmtDT = t => new Date(t).toISOString().slice(0, 19).replace('T', ' ');
async function twelvePages(sym, tf, total) {
  let out = [], end = '';
  while (out.length < total) {
    const n = Math.min(5000, total - out.length);
    const d = await getJSON(`https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(sym)}&interval=${TDI[tf]}&outputsize=${n}&timezone=UTC&apikey=${KEY}${end ? '&end_date=' + encodeURIComponent(end) : ''}`);
    if (d.status === 'error' || !d.values || !d.values.length) { if (out.length) break; throw new Error(d.message || 'Twelve Data қатесі'); }
    const rows = d.values.map(x => ({ t: Date.parse(x.datetime.replace(' ', 'T') + 'Z'), o: +x.open, h: +x.high, l: +x.low, c: +x.close })).reverse();
    out = rows.concat(out);
    end = fmtDT(rows[0].t - 1000);
    if (d.values.length < n) break;
    await sleep(7800);
  }
  const seen = new Set();
  return out.filter(x => !seen.has(x.t) && seen.add(x.t)).sort((a, b) => a.t - b.t);
}

// ---------- ranges ----------
const hourOf = t => { const d = new Date(t); return d.getUTCHours() + d.getUTCMinutes() / 60; };
const dayOf = t => new Date(t).toISOString().slice(0, 10);

function buildRanges(C, tf) {
  const byDay = new Map();
  C.forEach((x, i) => { const k = dayOf(x.t); if (!byDay.has(k)) byDay.set(k, []); byDay.get(k).push(i); });
  const keys = [...byDay.keys()].sort();
  const need = Math.floor(0.7 * (LON[1] - LON[0]) / TFH[tf]);
  const ranges = [];
  for (let k = 0; k < keys.length; k++) {
    const idx = byDay.get(keys[k]);
    const lon = idx.filter(i => { const h = hourOf(C[i].t); return h >= LON[0] && h < LON[1]; });
    if (lon.length < need) continue;
    let hi = -Infinity, lo = Infinity;
    for (const i of lon) { hi = Math.max(hi, C[i].h); lo = Math.min(lo, C[i].l); }
    const cands = [];
    for (const i of idx) { const h = hourOf(C[i].t); if (h >= NYW[0] && h < NYW[1]) cands.push({ i, win: 'NY' }); }
    if (k + 1 < keys.length) {
      for (const i of byDay.get(keys[k + 1])) { const h = hourOf(C[i].t); if (h >= LONW[0] && h < LONW[1]) cands.push({ i, win: 'LON' }); }
    }
    if (cands.length) ranges.push({ day: keys[k], hi, lo, cands });
  }
  return ranges;
}

// ---------- one range, one variant -> at most one trade ----------
function runVariant(C, r, v) {
  const mid = (r.hi + r.lo) / 2;
  for (const cd of r.cands) {
    if (v.win !== 'both' && cd.win !== v.win) continue;
    const i = cd.i, x = C[i], prev = C[i - 1];
    if (!prev) continue;
    let dir = 0, E = 0;
    if (v.entry === 'close') {
      if (prev.c <= r.hi && x.c > r.hi) { dir = 1; E = x.c; }
      else if (prev.c >= r.lo && x.c < r.lo) { dir = -1; E = x.c; }
    } else {
      const up = prev.c <= r.hi && x.h > r.hi, dn = prev.c >= r.lo && x.l < r.lo;
      if (up && dn) { dir = x.c >= x.o ? 1 : -1; } else if (up) dir = 1; else if (dn) dir = -1;
      if (dir === 1) E = Math.max(r.hi, x.o); else if (dir === -1) E = Math.min(r.lo, x.o);
    }
    if (!dir) continue;
    const dsl = v.sl === 'mid' ? Math.abs(E - mid) : v.sl === 'opp' ? Math.abs(E - (dir === 1 ? r.lo : r.hi)) : v.sl;
    if (!(dsl >= 1)) return null;
    const dtp = v.tp, SL = E - dir * dsl, TP = E + dir * dtp;
    let exit = null, out = 'TIME', last = x.c;
    let j = i;
    if (v.entry === 'stop') { // same candle: only the close is trusted
      if (dir === 1 ? x.c <= SL : x.c >= SL) { out = 'LOSS'; exit = SL; }
      else if (dir === 1 ? x.c >= TP : x.c <= TP) { out = 'WIN'; exit = TP; }
    }
    if (!exit) {
      for (j = i + 1; j < C.length && C[j].t - x.t <= DEADLINE_H * 36e5; j++) {
        const y = C[j]; last = y.c;
        if (dir === 1 ? y.l <= SL : y.h >= SL) { out = 'LOSS'; exit = dir === 1 ? Math.min(SL, y.o) : Math.max(SL, y.o); break; }
        if (dir === 1 ? y.h >= TP : y.l <= TP) { out = 'WIN'; exit = dir === 1 ? Math.max(TP, y.o) : Math.min(TP, y.o); break; }
      }
      if (!exit) exit = last;
    }
    const gross = dir * (exit - E);
    return { day: r.day, dir, E, dsl, dtp, out, gross, net: gross - COST };
  }
  return null;
}

function stats(T) {
  const S = { n: T.length, W: 0, L: 0, TIME: 0, gross: 0, net: 0, pos: 0, neg: 0, dd: 0, sq: 0 };
  let cum = 0, peak = 0;
  for (const t of T) {
    S[t.out === 'WIN' ? 'W' : t.out === 'LOSS' ? 'L' : 'TIME']++;
    S.gross += t.gross; S.net += t.net; S.sq += t.net * t.net;
    if (t.net > 0) S.pos += t.net; else S.neg -= t.net;
    cum += t.net; peak = Math.max(peak, cum); S.dd = Math.max(S.dd, peak - cum);
  }
  S.avg = S.n ? S.net / S.n : 0;
  S.pf = S.neg > 0 ? S.pos / S.neg : (S.pos > 0 ? 99 : 0);
  S.wr = S.n ? S.W / S.n * 100 : 0;
  const sd = S.n > 1 ? Math.sqrt(Math.max(0, S.sq / S.n - S.avg * S.avg)) : 0;
  S.t = S.n > 1 && sd > 0 ? S.avg / (sd / Math.sqrt(S.n)) : 0;
  return S;
}
const fmt = S => `${S.n} сауда · ${S.W}W/${S.L}L/${S.TIME}T · WR ${S.wr.toFixed(0)}% · Net ${S.net >= 0 ? '+' : ''}${S.net.toFixed(0)}$ · орт. ${S.avg >= 0 ? '+' : ''}${S.avg.toFixed(2)}$ · PF ${S.pf.toFixed(2)} · t=${S.t.toFixed(1)}`;

function evaluate(C, tf, ranges) {
  const SLS = [5, 7.5, 10, 15, 20, 30, 'mid', 'opp'], TPS = [5, 10, 15, 20], WINS = ['NY', 'LON', 'both'], ENTRY = ['close', 'stop'];
  const split = Math.floor(ranges.length * 0.7);
  const rows = [];
  for (const entry of ENTRY) for (const win of WINS) for (const sl of SLS) for (const tp of TPS) {
    const v = { entry, win, sl, tp }, tr = [], te = [];
    ranges.forEach((r, k) => { const t = runVariant(C, r, v); if (t) (k < split ? tr : te).push(t); });
    rows.push({ v, tr: stats(tr), te: stats(te) });
  }
  return { rows, split };
}
const vname = v => `${v.entry === 'close' ? 'шам жабылуы' : 'сызықта stop'} · ${v.win === 'both' ? 'NY+Лондон' : v.win === 'NY' ? 'NY' : 'Лондон'} · SL ${typeof v.sl === 'number' ? '$' + v.sl : v.sl === 'mid' ? 'range ортасы' : 'қарсы шет'} · TP $${v.tp}`;

async function main() {
  const t0 = Date.now(), lines = [];
  const log = s => { console.log(s); lines.push(s); };
  if (!KEY) throw new Error('TD_KEY secret керек (Twelve Data)');
  log(`AK Лондон range breakout backtest · ${SYMBOL} · pip=$${PIP} (100 pip=$${(100 * PIP).toFixed(0)}) · spread/комиссия $${COST} · ${new Date().toISOString().slice(0, 10)}`);
  const summary = [];
  for (const tf of TFS) {
    try {
      const C = await twelvePages(SYMBOL, tf, CANDLES[tf] || 5000);
      const ranges = buildRanges(C, tf);
      if (ranges.length < 40) throw new Error('Тым аз күн: ' + ranges.length);
      const days = Math.round((C[C.length - 1].t - C[0].t) / 864e5);
      const avgH = ranges.reduce((a, r) => a + (r.hi - r.lo), 0) / ranges.length;
      log(`\n==================== ${tf} ====================\n${C.length} шам, ~${days} күн, ${ranges.length} Лондон range, орташа range биіктігі $${avgH.toFixed(1)}`);
      const { rows, split } = evaluate(C, tf, ranges);
      log(`Train: ${split} күн · Test: ${ranges.length - split} күн (хронологиялық 70/30)`);

      log(`\n--- СІЗДІҢ ЕРЕЖЕ: шам жабылуы, NY+Лондон, TP $${100 * PIP} — SL іздеу ---`);
      for (const sl of [5, 7.5, 10, 15, 20, 30, 'mid', 'opp']) {
        const r = rows.find(x => x.v.entry === 'close' && x.v.win === 'both' && x.v.sl === sl && x.v.tp === 10);
        if (r) log(`SL ${typeof sl === 'number' ? '$' + sl : sl}\n   train ${fmt(r.tr)}\n   test  ${fmt(r.te)}`);
      }
      const cand = rows.filter(r => r.tr.n >= 30).sort((a, b) => b.tr.avg - a.tr.avg);
      log(`\n--- Train бойынша үздік 6 нұсқа (≥30 сауда) және олардың TEST нәтижесі ---`);
      cand.slice(0, 6).forEach(r => log(`${vname(r.v)}\n   train ${fmt(r.tr)}\n   test  ${fmt(r.te)}`));
      const ok = cand.filter(r => r.te.n >= 30 && r.tr.net > 0 && r.te.net > 0 && r.tr.pf > 1.1 && r.te.pf > 1.1);
      const nTried = rows.length;
      let verdict;
      if (ok.length) {
        const g = ok.sort((a, b) => b.te.avg - a.te.avg)[0];
        verdict = `${tf}: train мен test екеуінде де оң (PF>1.1) ${ok.length} нұсқа бар. Үздігі: ${vname(g.v)}; test орт. ${g.te.avg >= 0 ? '+' : ''}${g.te.avg.toFixed(2)}$/сауда (t=${g.te.t.toFixed(1)}). ${nTried} нұсқа сыналғандықтан кездейсоқ сәйкес келу ықтималдығы жоғары, оны алдымен басқа кезеңде қайта тексеру керек.`;
      } else verdict = `${tf}: train мен test екеуінде де тұрақты оң (PF>1.1, ≥30 сауда) нұсқа табылмады.`;
      log('\nҚОРЫТЫНДЫ ' + verdict);
      const base = rows.find(x => x.v.entry === 'close' && x.v.win === 'both' && x.v.sl === 10 && x.v.tp === 10);
      summary.push(`${tf}: сіздің ереже (SL $10, TP $10) test: ${fmt(base.te)}\n${verdict}`);
    } catch (e) { log(`\n== ${tf}: өткізілді — ${e.message}`); summary.push(`${tf}: ${e.message}`); }
  }
  log(`\nЕскертулер: сессия уақыты UTC бойынша (Лондон 07:00–16:00). Индикаторыңыздың уақыт белдеуі басқа болса, айтыңыз. Бір шамда SL мен TP бірге болса, SL саналады. Spread $${COST}/унция есептелген, slippage жоқ. Мәліметтің ұзындығы шектеулі, сондықтан нәтиже кезеңге тәуелді.`);
  log(`Уақыт: ${((Date.now() - t0) / 1000).toFixed(0)} сек.`);
  fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'data', 'session_backtest.txt'), lines.join('\n') + '\n');
  if (TG_TOKEN && TG_CHAT) {
    try { await fetch('https://api.telegram.org/bot' + TG_TOKEN + '/sendMessage', { method: 'POST', body: new URLSearchParams({ chat_id: TG_CHAT, text: ('🧪 Лондон breakout backtest\n\n' + summary.join('\n\n')).slice(0, 3900) }) }); } catch (e) { /* ignore */ }
  }
}

if (require.main === module) main().catch(e => { console.error(e.message); process.exitCode = 1; });
module.exports = { buildRanges, runVariant, stats };
