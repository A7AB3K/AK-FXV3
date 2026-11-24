'use strict';
// AK Trading AI — backtest. Walk-forward over history, grid of parameters,
// 70% train / 30% test (out-of-sample). Run from GitHub Actions: "AK Backtest".
const fs = require('fs');
const path = require('path');
const { SYMS, HTF, TFMS, analyze, evalEntry } = require('../engine.js');

const ROOT = path.join(__dirname, '..');
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const BT = CFG.backtest || {};
const TF = BT.tf || '15m';
const TOTAL = BT.candles || 12000;
const SYMBOLS = (BT.symbols || ['BTC/USDT', 'ETH/USDT', 'XAU/USD']).filter(n => SYMS[n]);
const TD_KEY = (process.env.TD_KEY || '').trim();
const TG_TOKEN = (process.env.TG_TOKEN || '').trim();
const TG_CHAT = (process.env.TG_CHAT || '').trim();
const TDI = { '5m': '5min', '15m': '15min', '1h': '1h', '4h': '4h', '1d': '1day' };
const OKX = { '5m': '5m', '15m': '15m', '1h': '1H', '4h': '4H', '1d': '1D' };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getJSON(u) {
  const r = await fetch(u, { signal: AbortSignal.timeout(25000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}
async function binanceAll(sym, tf, total) {
  let lastErr;
  for (const host of ['https://data-api.binance.vision', 'https://api.binance.com']) {
    try {
      let out = [], end = Date.now();
      while (out.length < total) {
        const d = await getJSON(`${host}/api/v3/klines?symbol=${sym}&interval=${tf}&limit=1000&endTime=${end}`);
        if (!d.length) break;
        out = d.map(k => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5], tb: +k[9] })).concat(out);
        end = d[0][0] - 1;
        if (d.length < 1000) break;
      }
      if (out.length) return out.slice(-total);
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('Binance бос');
}
async function okxAll(sym, tf, total) {
  const inst = sym.replace(/USDT$/, '-USDT');
  let out = [], after = '';
  while (out.length < total) {
    const d = (await getJSON(`https://www.okx.com/api/v5/market/history-candles?instId=${inst}&bar=${OKX[tf]}&limit=100${after ? '&after=' + after : ''}`)).data;
    if (!d || !d.length) break;
    const rows = d.map(k => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5], tb: null })).reverse();
    out = rows.concat(out); after = rows[0].t;
    await sleep(120);
  }
  if (!out.length) throw new Error('OKX бос');
  return out.slice(-total);
}
async function twelveAll(sym, tf, total) {
  const n = Math.min(total, 5000);
  const d = await getJSON(`https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(sym)}&interval=${TDI[tf]}&outputsize=${n}&timezone=UTC&apikey=${TD_KEY}`);
  if (d.status === 'error' || !d.values) throw new Error(d.message || 'Twelve Data қатесі');
  return d.values.reverse().map(x => ({ t: Date.parse(x.datetime.replace(' ', 'T') + 'Z'), o: +x.open, h: +x.high, l: +x.low, c: +x.close, v: +(x.volume || 0), tb: null }));
}
async function history(name, tf, total) {
  const s = SYMS[name];
  if (s.kind === 'crypto') { try { return await binanceAll(s.bn, tf, total); } catch (e) { return okxAll(s.bn, tf, total); } }
  if (!TD_KEY) throw new Error('TD_KEY secret керек (нақты XAU/USD / Forex тарихы үшін)');
  return twelveAll(s.td, tf, total);
}

// ---- walk-forward candidate generation (no look-ahead: only closed candles up to i) ----
function candidates(name, tf, L, H, k) {
  const out = [], htfMs = TFMS[HTF[tf]];
  let hp = 0;
  for (let i = 299; i < L.length - 1; i++) {
    const tClose = L[i].t + TFMS[tf];
    while (hp < H.length && H[hp].t + htfMs <= tClose) hp++;
    const hs = H.slice(Math.max(0, hp - 300), hp);
    if (hs.length < 60) continue;
    const r = analyze(L.slice(i - 299, i + 1), hs, name, tf, { minRiskATR: k, minRR: 0, minScore: 3, minAtrPct: 0 });
    if (r.sig !== 'WAIT' && r.plan) out.push({ i, t: L[i].t, sig: r.sig, score: r.score, plan: r.plan, A: r.A, px: r.px });
  }
  return out;
}

function simulate(L, tf, cands, v, from, to) {
  const trades = [], last = {};
  for (const c of cands) {
    if (c.i < from || c.i >= to) continue;
    if (Math.abs(c.score) < v.ms || c.plan.rr < v.rr || c.A / c.px < v.atr) continue;
    const prev = last[c.sig];
    if (prev) {
      const block = prev.t2 ? Math.max(prev.t + 4 * 36e5, prev.t2) : prev.t + 7 * 864e5;
      if (c.t < block) continue;
    }
    const e = { t: c.t, tf, sig: c.sig, entry: c.plan.entry, sl: c.plan.sl, tp1: c.plan.tp1, rr: c.plan.rr, st: c.plan.type === 'LIMIT' ? 'PENDING' : 'OPEN', R: 0 };
    evalEntry(e, L.slice(c.i + 1, c.i + 601));
    last[c.sig] = e; trades.push(e);
  }
  return trades;
}
const emptyStat = () => ({ W: 0, L: 0, miss: 0, exp: 0, R: 0, winR: 0 });
function addStat(S, trades) {
  for (const e of trades) {
    if (e.st === 'WIN') { S.W++; S.R += e.R; S.winR += e.R; }
    else if (e.st === 'LOSS') { S.L++; S.R -= 1; }
    else if (e.st === 'MISSED') S.miss++;
    else S.exp++;
  }
  return S;
}
const wr = S => (S.W + S.L ? S.W / (S.W + S.L) * 100 : 0);
const exp_ = S => (S.W + S.L ? S.R / (S.W + S.L) : 0);
const fmt = S => `${S.W + S.L} сауда · ${S.W}W/${S.L}L · WR ${wr(S).toFixed(0)}% · Net ${S.R > 0 ? '+' : ''}${S.R.toFixed(1)}R · орт. ${exp_(S) >= 0 ? '+' : ''}${exp_(S).toFixed(2)}R/сауда`;

const KS = [0.3, 0.8, 1.2, 1.6], RRS = [1.2, 1.5, 2], MSS = [3, 4, 5], ATRS = [0, 0.0003];
const vkey = v => `k${v.k}|rr${v.rr}|ms${v.ms}|atr${v.atr}`;
const BASE = { k: 0.3, rr: 1.2, ms: 3, atr: 0 };      // old (v1–v3) behaviour
const NEWDEF = { k: 1.2, rr: 1.5, ms: 3, atr: 0.0003 }; // new defaults

(async () => {
  const t0 = Date.now(), lines = [], res = {};
  const log = s => { console.log(s); lines.push(s); };
  log(`AK Backtest · TF ${TF} · ~${TOTAL} шам · ${new Date().toISOString().slice(0, 10)}`);
  const variants = [];
  for (const k of KS) for (const rr of RRS) for (const ms of MSS) for (const atr of ATRS) variants.push({ k, rr, ms, atr });

  for (const name of SYMBOLS) {
    try {
      const L = await history(name, TF, TOTAL);
      const need = Math.ceil(L.length * TFMS[TF] / TFMS[HTF[TF]]) + 400;
      const H = await history(name, HTF[TF], need);
      if (L.length < 1500) throw new Error('Тарих тым қысқа: ' + L.length);
      const split = Math.floor(299 + (L.length - 300) * 0.7);
      const days = ((L[L.length - 1].t - L[0].t) / 864e5).toFixed(0);
      log(`\n== ${name}: ${L.length} шам (~${days} күн), train/test бөлу: ${(100 * (split - 299) / (L.length - 300)).toFixed(0)}/${(100 - 100 * (split - 299) / (L.length - 300)).toFixed(0)}`);
      const byK = {};
      for (const k of KS) { byK[k] = candidates(name, TF, L, H, k); }
      res[name] = {};
      for (const v of variants) {
        res[name][vkey(v)] = {
          train: addStat(emptyStat(), simulate(L, TF, byK[v.k], v, 299, split)),
          test: addStat(emptyStat(), simulate(L, TF, byK[v.k], v, split, L.length))
        };
      }
      const b = res[name][vkey(BASE)], n = res[name][vkey(NEWDEF)];
      log(`Ескі ереже  train: ${fmt(b.train)}\n            test : ${fmt(b.test)}`);
      log(`Жаңа ереже  train: ${fmt(n.train)}\n            test : ${fmt(n.test)}`);
    } catch (e) { log(`\n== ${name}: өткізілді — ${e.message}`); }
  }

  // combined ranking
  const names = Object.keys(res);
  const rows = [];
  for (const v of variants) {
    const tr = emptyStat(), te = emptyStat();
    for (const n of names) { const r = res[n][vkey(v)]; for (const f of ['W', 'L', 'miss', 'exp', 'R', 'winR']) { tr[f] += r.train[f]; te[f] += r.test[f]; } }
    rows.push({ v, tr, te });
  }
  const MINTR = 15;
  const cand = rows.filter(r => r.tr.W + r.tr.L >= MINTR).sort((a, b) => exp_(b.tr) - exp_(a.tr));
  log(`\n=== БАРЛЫҚ НАРЫҚ БІРГЕ (${names.join(', ') || '—'}) ===`);
  const bRow = rows.find(r => vkey(r.v) === vkey(BASE)), nRow = rows.find(r => vkey(r.v) === vkey(NEWDEF));
  if (bRow) log(`Ескі ереже : train ${fmt(bRow.tr)}\n             test  ${fmt(bRow.te)}`);
  if (nRow) log(`Жаңа ереже : train ${fmt(nRow.tr)}\n             test  ${fmt(nRow.te)}`);
  log(`\nTrain бойынша үздік 6 нұсқа (кемінде ${MINTR} сауда) және олардың TEST нәтижесі:`);
  cand.slice(0, 6).forEach(r => log(`SL≥${r.v.k}ATR RR≥${r.v.rr} score≥${r.v.ms} ATR%≥${r.v.atr}\n   train ${fmt(r.tr)}\n   test  ${fmt(r.te)}`));
  const good = cand.filter(r => r.te.W + r.te.L >= 10 && exp_(r.te) > 0.05 && exp_(r.tr) > 0.05);
  let verdict;
  if (good.length) {
    const g = good.sort((a, b) => exp_(b.te) - exp_(a.te))[0];
    verdict = `Train мен test екеуінде де оң нұсқа бар: SL≥${g.v.k}ATR, RR≥${g.v.rr}, score≥${g.v.ms}, ATR%≥${g.v.atr}.\nconfig.json-ға: "params": {"minRiskATR": ${g.v.k}, "minRR": ${g.v.rr}, "minScore": ${g.v.ms}, "minAtrPct": ${g.v.atr}}\nЕскерту: бұл өткен деректегі нәтиже, болашақты кепілдемейді. Комиссия мен slippage есептелмеген.`;
  } else {
    verdict = 'Ешбір нұсқа train да, test те (out-of-sample) тұрақты оң нәтиже бермеді. Бұл ереже жиынтығына нақты ақшамен сенуге болмайды; сигналдарды тек бақылау үшін қолданыңыз.';
  }
  log('\nҚОРЫТЫНДЫ: ' + verdict);
  log(`\nУақыт: ${((Date.now() - t0) / 1000).toFixed(0)} сек. Бір candle ішінде SL мен TP1 бірге болса — SL саналады (қатаң). Комиссия жоқ.`);

  fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'data', 'backtest.txt'), lines.join('\n') + '\n');
  if (TG_TOKEN && TG_CHAT) {
    const head = `🧪 Backtest (${TF}, ${names.join(', ')})\n` + (bRow ? `Ескі: test ${fmt(bRow.te)}\n` : '') + (nRow ? `Жаңа: test ${fmt(nRow.te)}\n` : '') + `\n${verdict.split('\n')[0]}`;
    try { await fetch('https://api.telegram.org/bot' + TG_TOKEN + '/sendMessage', { method: 'POST', body: new URLSearchParams({ chat_id: TG_CHAT, text: head.slice(0, 3900) }) }); } catch (e) { /* ignore */ }
  }
  if (!names.length) process.exitCode = 1;
})();
