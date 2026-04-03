import fetch from "node-fetch";

// ======================
// 🔥 설정
// ======================
const TG_TOKEN = "8650566978:AAH2273LrbNTjmtsIvPLTALVz-6wgSi4n3Y";
const TG_CHAT_ID = "6363226823";

const TOP_N = 100;
const MIN_SCORE = 60;

// ======================
// 🔥 텔레그램
// ======================
async function sendTelegram(msg) {
  await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: "POST",
    headers: {"Content-Type":"application/json"},
    body: JSON.stringify({
      chat_id: TG_CHAT_ID,
      text: msg
    })
  });
}

// ======================
// 🔥 BTC 필터
// ======================
let btcTrend = 'NEUTRAL';

async function getBTCTrend() {
  const r = await fetch("https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=4h&limit=50");
  const d = await r.json();

  const first = +d[0][4];
  const last = +d[d.length - 1][4];
  const pct = (last - first) / first;

  if (pct > 0.03) btcTrend = "UP";
  else if (pct < -0.03) btcTrend = "DOWN";
}

// ======================
// 🔥 심볼
// ======================
async function getTopSymbols() {
  const r = await fetch("https://fapi.binance.com/fapi/v1/ticker/24hr");
  const d = await r.json();

  return d
    .filter(x => x.symbol.endsWith("USDT"))
    .sort((a,b) => b.quoteVolume - a.quoteVolume)
    .slice(0, TOP_N)
    .map(x => x.symbol);
}

// ======================
// 🔥 캔들
// ======================
async function getCandles(symbol) {
  const r = await fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=4h&limit=200`);
  const d = await r.json();

  return d.map(c => ({
    o:+c[1], h:+c[2], l:+c[3], c:+c[4], v:+c[5]
  }));
}

// ======================
// 🔥 WYCKOFF (핵심 이식)
// ======================
function detectWyckoff(c) {

  const R = 60;
  const T = 80;
  if (c.length < R + T) return null;

  const rc = c.slice(-R);
  const tc = c.slice(-(R + T), -R);

  // trend
  const first = tc[0].c;
  const last = tc[tc.length-1].c;
  const tPct = (last - first)/first;

  let pattern;
  if (tPct < -0.1) pattern = 'ACCUMULATION';
  else if (tPct > 0.1) pattern = 'DISTRIBUTION';
  else return null;

  // range
  const rHigh = Math.max(...rc.map(x=>x.h));
  const rLow  = Math.min(...rc.map(x=>x.l));
  const rPct  = (rHigh - rLow) / rLow;

  if (rPct > 0.25 || rPct < 0.02) return null;

  // volume
  const avgVol = rc.reduce((s,x)=>s+x.v,0)/rc.length;

  // climax
  let climaxVolRel = 0;
  rc.forEach(x=>{
    const vr = x.v / avgVol;
    if (vr > climaxVolRel) climaxVolRel = vr;
  });

  if (climaxVolRel < 1.8) return null;

  // volume ratio
  const v1 = rc.slice(0,30).reduce((s,x)=>s+x.v,0)/30;
  const v2 = rc.slice(30).reduce((s,x)=>s+x.v,0)/30;
  const volRatio = v2 / v1;

  if (volRatio > 1.2) return null;

  // score
  let score = 0;
  score += Math.min(20, Math.abs(tPct)*100);
  score += Math.min(20, (1-rPct)*50);
  score += Math.min(20, climaxVolRel*5);
  score += Math.min(20, (1-volRatio)*20);

  score = Math.round(score);

  const price = c[c.length-1].c;

  return {
    pattern,
    score,
    price
  };
}

// ======================
// 🔥 중복 방지
// ======================
const alerted = new Set();

// ======================
// 🔥 메인
// ======================
async function scan() {

  console.log("SCAN START");

  await getBTCTrend();
  const symbols = await getTopSymbols();

  for (let s of symbols) {
    try {

      const candles = await getCandles(s);
      const res = detectWyckoff(candles);

      if (!res) continue;
      if (res.score < MIN_SCORE) continue;

      // BTC 필터
      if (btcTrend === 'DOWN' && res.pattern === 'ACCUMULATION') continue;
      if (btcTrend === 'UP' && res.pattern === 'DISTRIBUTION') continue;

      const key = s + res.pattern;
      if (alerted.has(key)) continue;
      alerted.add(key);

      const msg = `
🚨 Wyckoff Signal

${s}
Pattern: ${res.pattern}
Score: ${res.score}
BTC: ${btcTrend}
Price: ${res.price}
      `;

      console.log(msg);
      await sendTelegram(msg);

    } catch(e){}
  }
}

// ======================
setInterval(scan, 1000*60*5);
scan();
