import fetch from "node-fetch";
import http from "http";

// ==========================
// 🔥 설정
// ==========================
const TG_TOKEN = "8650566978:AAH2273LrbNTjmtsIvPLTALVz-6wgSi4n3Y";
const TG_CHAT_ID = "6363226823";

const TOP_N = 50;
const MIN_SCORE = 60;

// ==========================
// 🔥 텔레그램
// ==========================
async function sendTelegram(msg) {
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: "POST",
      headers: {"Content-Type":"application/json"},
      body: JSON.stringify({
        chat_id: TG_CHAT_ID,
        text: msg
      })
    });
  } catch (e) {
    console.log("텔레그램 전송 실패");
  }
}

// ==========================
// 🔥 BTC 방향
// ==========================
let btcTrend = "NEUTRAL";

async function getBTCTrend() {
  try {
    const r = await fetch("https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=4h&limit=50");
    const d = await r.json();

    const first = +d[0][4];
    const last = +d[d.length - 1][4];
    const pct = (last - first) / first;

    if (pct > 0.03) btcTrend = "UP";
    else if (pct < -0.03) btcTrend = "DOWN";
    else btcTrend = "NEUTRAL";

  } catch {
    btcTrend = "NEUTRAL";
  }
}

// ==========================
// 🔥 심볼 가져오기
// ==========================
async function getTopSymbols() {
  const r = await fetch("https://fapi.binance.com/fapi/v1/ticker/24hr");
  const d = await r.json();

  return d
    .filter(x => x.symbol.endsWith("USDT"))
    .sort((a,b) => b.quoteVolume - a.quoteVolume)
    .slice(0, TOP_N)
    .map(x => x.symbol);
}

// ==========================
// 🔥 캔들
// ==========================
async function getCandles(symbol) {
  const r = await fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=4h&limit=200`);
  const d = await r.json();

  return d.map(c => ({
    o:+c[1], h:+c[2], l:+c[3], c:+c[4], v:+c[5]
  }));
}

// ==========================
// 🔥 Wyckoff 로직
// ==========================
function detect(c) {
  if (c.length < 100) return null;

  const closes = c.map(x=>x.c);
  const first = closes[0];
  const last = closes[closes.length-1];

  const trend = (last - first) / first;

  let pattern;
  if (trend < -0.1) pattern = "ACCUMULATION";
  else if (trend > 0.1) pattern = "DISTRIBUTION";
  else return null;

  const rangeHigh = Math.max(...c.slice(-60).map(x=>x.h));
  const rangeLow  = Math.min(...c.slice(-60).map(x=>x.l));
  const rPct = (rangeHigh - rangeLow) / rangeLow;

  if (rPct > 0.25 || rPct < 0.02) return null;

  const avgVol = c.slice(-60).reduce((s,x)=>s+x.v,0)/60;
  let climax = 0;

  c.slice(-60).forEach(x=>{
    const vr = x.v / avgVol;
    if (vr > climax) climax = vr;
  });

  if (climax < 1.8) return null;

  let score = Math.floor(
    Math.abs(trend)*100 +
    (1-rPct)*50 +
    climax*5
  );

  return {
    pattern,
    score,
    price: last
  };
}

// ==========================
// 🔥 중복 방지
// ==========================
const alerted = new Set();

// ==========================
// 🔥 메인 스캔
// ==========================
async function scan() {
  console.log("SCAN START");

  await getBTCTrend();
  console.log("BTC:", btcTrend);

  const symbols = await getTopSymbols();

  for (let s of symbols) {
    try {
      const candles = await getCandles(s);
      const res = detect(candles);

      if (!res) continue;
      if (res.score < MIN_SCORE) continue;

      // BTC 필터
      if (btcTrend === "DOWN" && res.pattern === "ACCUMULATION") continue;
      if (btcTrend === "UP" && res.pattern === "DISTRIBUTION") continue;

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

    } catch(e) {
      console.log("에러:", s);
    }
  }
}

// ==========================
// 🔥 서버 (이거 없으면 꺼짐)
// ==========================
http.createServer((req, res) => {
  res.end("Bot Running");
}).listen(3000);

console.log("웹서버 실행됨");

// ==========================
// 🔥 실행 루프
// ==========================
function start() {
  console.log("봇 시작됨");

  scan();

  setInterval(scan, 1000 * 60 * 5); // 5분마다
}

// 살아있음 로그
setInterval(() => {
  console.log("alive...");
}, 60000);

start();
