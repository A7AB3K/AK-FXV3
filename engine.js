// AK Trading AI — shared engine (browser + Node scanner)
const SYMS={
 'XAU/USD':{td:'XAU/USD',bn:'PAXGUSDT',kind:'gold'},
 'EUR/USD':{td:'EUR/USD',kind:'fx'},'GBP/USD':{td:'GBP/USD',kind:'fx'},'USD/JPY':{td:'USD/JPY',kind:'fx'},
 'AUD/USD':{td:'AUD/USD',kind:'fx'},'USD/CAD':{td:'USD/CAD',kind:'fx'},
 'BTC/USDT':{bn:'BTCUSDT',kind:'crypto'},'ETH/USDT':{bn:'ETHUSDT',kind:'crypto'},
 'SOL/USDT':{bn:'SOLUSDT',kind:'crypto'},'XRP/USDT':{bn:'XRPUSDT',kind:'crypto'}
};
const HTF={'5m':'1h','15m':'4h','1h':'1d','4h':'1d'};
/* ---------- ICT / MP / OF engine ---------- */
function atr(c,n=14){let s=0,k=0;for(let i=Math.max(1,c.length-n);i<c.length;i++){s+=Math.max(c[i].h-c[i].l,Math.abs(c[i].h-c[i-1].c),Math.abs(c[i].l-c[i-1].c));k++}return s/k}
function pivots(c,n=3){
  const ph=[],pl=[];
  for(let i=n;i<c.length-n;i++){
    let H=true,L=true;
    for(let j=1;j<=n;j++){if(c[i].h<=c[i-j].h||c[i].h<=c[i+j].h)H=false;if(c[i].l>=c[i-j].l||c[i].l>=c[i+j].l)L=false}
    if(H)ph.push({i,p:c[i].h});if(L)pl.push({i,p:c[i].l});
  }
  return {ph,pl};
}
function structure(c){
  const {ph,pl}=pivots(c),px=c[c.length-1].c;
  let bias='range',event='';
  if(ph.length>=2&&pl.length>=2){
    const hh=ph.at(-1).p>ph.at(-2).p,hl=pl.at(-1).p>pl.at(-2).p;
    if(hh&&hl)bias='bull';else if(!hh&&!hl)bias='bear';
  }
  if(ph.length&&px>ph.at(-1).p)event=bias==='bear'?'CHoCH bullish':'BOS bullish';
  else if(pl.length&&px<pl.at(-1).p)event=bias==='bull'?'CHoCH bearish':'BOS bearish';
  return {bias,event,ph,pl};
}
function zones(c,A){
  const Z=[],n=c.length,from=Math.max(2,n-120);
  for(let i=from;i<n;i++){
    // FVG
    if(c[i-2].h<c[i].l){const bot=c[i-2].h,top=c[i].l;if(top-bot>0.15*A&&!c.slice(i+1).some(x=>x.l<bot))Z.push({type:'FVG',dir:'bull',top,bot,i})}
    if(c[i-2].l>c[i].h){const top=c[i-2].l,bot=c[i].h;if(top-bot>0.15*A&&!c.slice(i+1).some(x=>x.h>top))Z.push({type:'FVG',dir:'bear',top,bot,i})}
  }
  for(let i=from;i<n-2;i++){
    const nx=c[i+1],body=Math.abs(nx.c-nx.o);
    if(c[i].c<c[i].o&&nx.c>c[i].h&&body>1.1*A&&!c.slice(i+2).some(x=>x.c<c[i].l))Z.push({type:'OB',dir:'bull',top:c[i].h,bot:c[i].l,i});
    if(c[i].c>c[i].o&&nx.c<c[i].l&&body>1.1*A&&!c.slice(i+2).some(x=>x.c>c[i].h))Z.push({type:'OB',dir:'bear',top:c[i].h,bot:c[i].l,i});
  }
  return Z;
}
function sweep(c,ph,pl){
  const n=c.length;
  for(const p of pl){for(let j=Math.max(p.i+4,n-10);j<n;j++)if(c[j].l<p.p&&c[j].c>p.p)return {dir:'bull',lvl:p.p}}
  for(const p of ph){for(let j=Math.max(p.i+4,n-10);j<n;j++)if(c[j].h>p.p&&c[j].c<p.p)return {dir:'bear',lvl:p.p}}
  return null;
}
function profile(c){
  const s=c.slice(-120),lo=Math.min(...s.map(x=>x.l)),hi=Math.max(...s.map(x=>x.h)),B=48,st=(hi-lo)/B||1,bins=new Array(B).fill(0);
  for(const x of s){
    const v=x.v||1,a=Math.min(B-1,Math.floor((x.l-lo)/st)),b=Math.min(B-1,Math.floor((x.h-lo)/st));
    for(let k=a;k<=b;k++)bins[k]+=v/(b-a+1);
  }
  const tot=bins.reduce((a,b)=>a+b,0);let poc=bins.indexOf(Math.max(...bins)),a=poc,b=poc,acc=bins[poc];
  while(acc<tot*0.7&&(a>0||b<B-1)){
    const up=b<B-1?bins[b+1]:-1,dn=a>0?bins[a-1]:-1;
    if(up>=dn){b++;acc+=bins[b]}else{a--;acc+=bins[a]}
  }
  return {bins,lo,st,poc:lo+(poc+.5)*st,vah:lo+(b+1)*st,val:lo+a*st};
}
function delta(c){
  const s=c.slice(-20);let cd=0,real=s[0].tb!=null&&s[0].tb>0;
  for(const x of s)cd+=real?2*x.tb-x.v:x.v*((x.c-x.o)/((x.h-x.l)||1));
  const tot=s.reduce((a,x)=>a+(x.v||0),0)||1;
  return {cd,pct:cd/tot*100,real,pxUp:s.at(-1).c>s[0].c};
}
function session(){
  const h=new Date().getUTCHours();
  if(h>=7&&h<10)return 'London Killzone';if(h>=12&&h<16)return 'New York Killzone';if(h<4)return 'Asian Session';return 'Killzone сыртында';
}
const dec=p=>p>=1000?2:p>=10?3:5;

const DEFAULTS={minRiskATR:1.2,minRR:1.5,minScore:3,minAtrPct:0.0003};
function plan(dir,px,A,Z,ph,pl,O){
  O=O||DEFAULTS;
  const s=dir==='BUY'?1:-1;
  const cand=Z.filter(z=>s>0?(z.dir==='bull'&&z.top<=px+.2*A):(z.dir==='bear'&&z.bot>=px-.2*A))
    .filter(z=>Math.abs((s>0?z.top:z.bot)-px)<=3*A).sort((a,b)=>s>0?b.top-a.top:a.bot-b.bot)[0];
  let entry=px,base;
  if(cand){const inside=px>=cand.bot&&px<=cand.top;entry=inside?px:(cand.top+cand.bot)/2;base=s>0?cand.bot:cand.top}
  else{const arr=(s>0?pl:ph).filter(p=>s>0?p.p<px:p.p>px).map(p=>p.p);base=arr.length?(s>0?arr.at(-1):arr.at(-1)):px-s*1.5*A}
  let sl=base-s*.25*A,risk=Math.abs(entry-sl);
  if(risk<O.minRiskATR*A){sl=entry-s*O.minRiskATR*A;risk=O.minRiskATR*A}
  if(risk>5*A)return null;
  const tg=(s>0?ph:pl).map(p=>p.p).filter(p=>s>0?p>entry+1.2*risk:p<entry-1.2*risk).sort((a,b)=>s>0?a-b:b-a)[0];
  const tp1=tg!=null?tg:entry+s*1.5*risk;
  let tp2=entry+s*3*risk;if(Math.abs(tp2-entry)<=Math.abs(tp1-entry))tp2=tp1+s*1.5*risk;
  return {entry,sl,tp1,tp2,rr:Math.abs(tp1-entry)/risk,type:cand&&entry!==px?'LIMIT':'MARKET',zone:cand||null};
}

function analyze(c,h,name,tf,opts){
  const O=Object.assign({},DEFAULTS,opts||{});
  const n=c.length,px=c.at(-1).c,A=atr(c),R=[];let sc=0;
  const add=(t,s)=>{R.push({t,s});sc+=s};
  const sH=structure(h),sL=structure(c),Z=zones(c,A),sw=sweep(c,sL.ph,sL.pl),P=profile(c),D=delta(c);
  const HT=HTF[tf];
  if(sH.bias==='bull')add(`HTF (${HT}) Market Structure: Bullish — HH + HL, үлкен тренд жоғары.`,2);
  else if(sH.bias==='bear')add(`HTF (${HT}) Market Structure: Bearish — LH + LL, үлкен тренд төмен.`,-2);
  else add(`HTF (${HT}) Market Structure: Range — анық тренд жоқ.`,0);
  if(sL.bias==='bull')add(`LTF (${tf}) құрылым Bullish.`,1);else if(sL.bias==='bear')add(`LTF (${tf}) құрылым Bearish.`,-1);
  if(sL.event){const b=sL.event.includes('bullish');add(`${sL.event}: баға соңғы swing деңгейін ${b?'жоғары':'төмен'} бұзды${sL.event.startsWith('CHoCH')?' — тренд бағыты өзгеруі мүмкін':' — тренд жалғасуы'}.`,b?1:-1)}
  if(sw)add(sw.dir==='bull'?`Sell-side Liquidity Sweep: баға ${sw.lvl.toFixed(dec(px))} төменгі liquidity-ді алып, жоғары қайтты — Bullish сигнал.`:`Buy-side Liquidity Sweep: баға ${sw.lvl.toFixed(dec(px))} жоғарғы liquidity-ді алып, төмен қайтты — Bearish сигнал.`,sw.dir==='bull'?2:-2);
  const rg=c.slice(-60),hi=Math.max(...rg.map(x=>x.h)),lo=Math.min(...rg.map(x=>x.l)),pos=(px-lo)/((hi-lo)||1);
  if(pos<.45)add(`Discount аймағында (${Math.round(pos*100)}%) — Buy үшін қолайлы баға.`,1);
  else if(pos>.55)add(`Premium аймағында (${Math.round(pos*100)}%) — Sell үшін қолайлы баға.`,-1);
  else add('Equilibrium (50%) маңында — баға әділ деңгейде.',0);
  const nb=Z.filter(z=>z.dir==='bull'&&z.top<=px+.2*A&&z.top>=px-3*A),ns=Z.filter(z=>z.dir==='bear'&&z.bot>=px-.2*A&&z.bot<=px+3*A);
  if(nb.length&&!ns.length)add(`Төменде Bullish ${nb[0].type} бар (${nb[0].bot.toFixed(dec(px))}–${nb[0].top.toFixed(dec(px))}) — қолдау аймағы.`,1);
  else if(ns.length&&!nb.length)add(`Жоғарыда Bearish ${ns[0].type} бар (${ns[0].bot.toFixed(dec(px))}–${ns[0].top.toFixed(dec(px))}) — кедергі аймағы.`,-1);
  else if(nb.length&&ns.length)add('Екі жақта да FVG/OB бар — баға қысылған, нақты артықшылық жоқ.',0);
  if(px>P.vah&&sH.bias==='bull')add(`Баға Value Area High (${P.vah.toFixed(dec(px))}) үстінде — жоғарыда қабылдау (acceptance).`,1);
  else if(px<P.val&&sH.bias==='bear')add(`Баға Value Area Low (${P.val.toFixed(dec(px))}) астында — төменде қабылдау.`,-1);
  else if(px>=P.val&&px<=P.vah)add(`Баға Value Area ішінде (POC ${P.poc.toFixed(dec(px))}) — rotation/range ықтималдығы жоғары.`,0);
  const src=D.real?'нақты taker buy/sell':'approximation (candle негізінде)';
  if(D.pxUp&&D.cd<0)add(`Order Flow: баға өсті, бірақ Cumulative Delta теріс — Bearish divergence (${src}).`,-1);
  else if(!D.pxUp&&D.cd>0)add(`Order Flow: баға түсті, бірақ Cumulative Delta оң — Bullish divergence (${src}).`,1);
  else if(D.cd>0)add(`Order Flow: Delta оң (${D.pct.toFixed(1)}%) — сатып алушылар басым (${src}).`,1);
  else add(`Order Flow: Delta теріс (${D.pct.toFixed(1)}%) — сатушылар басым (${src}).`,-1);

  let sig=sc>=O.minScore?'BUY':sc<=-O.minScore?'SELL':'WAIT',pl_=null,why='';
  if(sig!=='WAIT'&&A/px<O.minAtrPct){why='Нарық тым тыныш (ATR өте аз) — сигнал сенімсіз.';sig='WAIT'}
  if(sig!=='WAIT'){
    pl_=plan(sig,px,A,Z,sL.ph,sL.pl,O);
    if(!pl_){why='Stop Loss тым алыс — тәуекел/пайда қатынасы нашар.';sig='WAIT'}
    else if(pl_.rr<O.minRR){why=`R:R тым төмен (${pl_.rr.toFixed(2)}).`;sig='WAIT';pl_=null}
  }
  const ses=session();
  const bias=sc>0?'Bullish':sc<0?'Bearish':'Neutral';
  let exp;
  if(sig==='WAIT')exp=`Қазір ${name} бойынша сенімді setup жоқ (Score ${sc>0?'+':''}${sc}).${why?' '+why:''}\nФакторлар бір-біріне қайшы немесе жеткіліксіз. Күту — де позиция емес, дұрыс шешім. Баға Order Block / FVG аймағына жақындағанда не liquidity sweep болғанда қайта талдаңыз.`;
  else exp=`${name} бойынша ${sig==='BUY'?'сатып алу':'сату'} (${sig}) идеясы: ICT бағыты ${bias}, Score ${sc>0?'+':''}${sc}.\n${pl_.type==='LIMIT'?`Entry — ${pl_.zone.type} аймағына Limit ордер: баға ${pl_.entry.toFixed(dec(px))} деңгейіне қайтқанда кіру.`:'Баға қазір қолайлы аймақта — Market Entry қарастыруға болады, бірақ confirmation (LTF-те свеча жабылуы) күтіңіз.'}\nStop Loss — құрылым деңгейінің арғы жағында (ATR буфермен). TP1 — келесі liquidity деңгейі, TP2 — 3R. R:R = 1:${pl_.rr.toFixed(2)}.\nТәуекел: бір сауда үшін депозиттің 1% шамасынан аспаңыз. TP1-де позицияның жартысын жауып, SL-ді Break Even-ге жылжыту — жиі қолданылатын тәсіл.`;
  exp+=`\nСессия: ${ses}.${ses==='Killzone сыртында'&&SYMS[name].kind!=='crypto'?' Killzone сыртында ликвидтілік төмен — сигналдың сапасы төмендеуі мүмкін.':''}`;
  return {sig,score:sc,plan:pl_,reasons:R,exp,px,P,Z,A,dec:dec(px)};
}

/* v2-pure-start */
const TFMS={'5m':3e5,'15m':9e5,'1h':36e5,'4h':144e5,'1d':864e5};
// Candle-by-candle outcome tracking. Conservative: if SL and TP1 are in the same candle, SL wins.
function evalEntry(e,cs){
  const b=e.sig==='BUY';
  for(const x of cs){
    if(x.t<=e.t)continue;
    if(e.st==='PENDING'){
      const fill=b?x.l<=e.entry:x.h>=e.entry;
      if(!fill){
        if(b?x.h>=e.tp1:x.l<=e.tp1){e.st='MISSED';e.t2=x.t;return e.st}
        if(x.t-e.t>TFMS[e.tf]*48){e.st='EXPIRED';e.t2=x.t;return e.st}
        continue;
      }
      e.st='OPEN';
    }
    if(e.st==='OPEN'){
      if(b?x.l<=e.sl:x.h>=e.sl){e.st='LOSS';e.R=-1;e.t2=x.t;return e.st}
      if(b?x.h>=e.tp1:x.l<=e.tp1){e.st='WIN';e.R=e.rr;e.t2=x.t;return e.st}
    }
  }
  const age=Date.now()-e.t;
  if(e.st==='PENDING'&&age>TFMS[e.tf]*48)e.st='EXPIRED';
  if(e.st==='OPEN'&&age>7*864e5)e.st='EXPIRED';
  return e.st;
}
function calcStats(J){
  const w=J.filter(e=>e.st==='WIN').length,l=J.filter(e=>e.st==='LOSS').length,o=J.filter(e=>e.st==='OPEN'||e.st==='PENDING').length;
  const R=J.reduce((a,e)=>a+(e.st==='WIN'||e.st==='LOSS'?e.R:0),0);
  return {n:J.length,w,l,o,wr:w+l?w/(w+l)*100:0,R};
}
function sigText(e){
  const f=v=>(+v).toFixed(e.d);
  return `${e.sig==='BUY'?'🟢':'🔴'} ${e.sig} · ${e.name} · ${e.tf}\nEntry (${e.type}): ${f(e.entry)}\nSL: ${f(e.sl)}\nTP1: ${f(e.tp1)}\nTP2: ${f(e.tp2)}\nR:R 1:${(+e.rr).toFixed(2)} · Score ${e.score>0?'+':''}${e.score}\n\n`+e.top.map(x=>'• '+x).join('\n')+`\n\n⚠ Қаржылық кеңес емес. Тәуекел ≤ 1%.`;
}
/* v2-pure-end */
if(typeof module!=='undefined')module.exports={DEFAULTS,SYMS,HTF,TFMS,dec,analyze,evalEntry,calcStats,sigText};
