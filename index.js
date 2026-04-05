// ================================
// IMPORTS
// ================================
import fetch from 'node-fetch';
import express from 'express';

// ================================
// CONFIG
// ================================
const CONFIG = {
  API: 'https://fapi.binance.com',
  TOP_N: 40,
  BATCH: 5,
  INTERVAL: 60000,
  TELEGRAM_TOKEN: '8650566978:AAH2273LrbNTjmtsIvPLTALVz-6wgSi4n3Y',
  CHAT_ID: '6363226823',
  TIMEOUT: 10000,
  RETRY: 3,
  PORT: process.env.PORT || 3000
};

// ================================
// GLOBAL SAFE GUARD
// ================================
process.on('uncaughtException', err => console.error('🔥 UNCAUGHT:', err));
process.on('unhandledRejection', err => console.error('🔥 REJECTION:', err));

// ================================
// UTILS
// ================================
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ================================
// SAFE FETCH
// ================================
async function safeFetch(url, retry = CONFIG.RETRY, options = {}) {
  for (let i = 0; i < retry; i++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), CONFIG.TIMEOUT);
      const res = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timeout);
      return await res.json();
    } catch (e) {
      if (i === retry - 1) {
        console.error(`fetch fail: ${url}`);
        return null;
      }
      await sleep(1000);
    }
  }
}

// ================================
// TELEGRAM
// ================================
async function sendTelegram(msg) {
  try {
    if (!CONFIG.TELEGRAM_TOKEN || !CONFIG.CHAT_ID) return;

    await fetch(`https://api.telegram.org/bot${CONFIG.TELEGRAM_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: CONFIG.CHAT_ID,
        text: msg
      })
    });

  } catch (e) {
    console.error('텔레그램 실패');
  }
}

// ================================
// API
// ================================
async function getTopSymbols() {
  const data = await safeFetch(`${CONFIG.API}/fapi/v1/ticker/24hr`);
  if (!data) return [];

  return data
    .filter(x => x.symbol.endsWith('USDT') && +x.quoteVolume > 10000000)
    .sort((a,b) => +b.quoteVolume - +a.quoteVolume)
    .slice(0, CONFIG.TOP_N)
    .map(x => ({
      symbol: x.symbol,
      pricePct: +parseFloat(x.priceChangePercent)
    }));
}

async function getFunding(symbol) {
  const d = await safeFetch(`${CONFIG.API}/fapi/v1/premiumIndex?symbol=${symbol}`);
  return d ? parseFloat(d.lastFundingRate) * 100 : 0;
}

async function getOI(symbol) {
  const d = await safeFetch(`${CONFIG.API}/futures/data/openInterestHist?symbol=${symbol}&period=4h&limit=5`);
  if (!d || !d.length) return 0;

  const vals = d.map(x => +x.sumOpenInterestValue);
  return ((vals.at(-1) - vals[0]) / vals[0]) * 100;
}

async function getLS(symbol) {
  const d = await safeFetch(`${CONFIG.API}/futures/data/globalLongShortAccountRatio?symbol=${symbol}&period=4h&limit=1`);
  return d && d.length ? parseFloat(d[0].longShortRatio) : 1;
}

async function getTaker(symbol) {
  const d = await safeFetch(`${CONFIG.API}/futures/data/takerlongshortRatio?symbol=${symbol}&period=4h&limit=5`);
  if (!d || !d.length) return 1;

  const vals = d.map(x => parseFloat(x.buySellRatio));
  return vals.reduce((a,b)=>a+b,0)/vals.length;
}

// ================================
// WYCKOFF (구조)
// ================================
function detectWyckoff({ oi, ls, fr }) {
  if (oi > 3 && ls < 1 && fr < -0.01) return 'ACCUMULATION';
  if (oi > 3 && ls > 1.5 && fr > 0.01) return 'DISTRIBUTION';
  return 'NONE';
}

// ================================
// SMART MONEY 필터
// ================================
function smartMoneyFilter({ oi, fr }) {
  if (oi > 6 && Math.abs(fr) > 0.02) return true;
  return false;
}

// ================================
// SIGNAL (고확률)
// ================================
function detectSignal({ fr, oi, taker, wyckoff }) {

  if (
    wyckoff === 'ACCUMULATION' &&
    fr < -0.03 &&
    oi > 6 &&
    taker > 1.12
  ) return '🚀 PREMIUM LONG';

  if (
    wyckoff === 'DISTRIBUTION' &&
    fr > 0.03 &&
    oi > 6 &&
    taker < 0.88
  ) return '🔻 PREMIUM SHORT';

  return null;
}

// ================================
// DUPLICATE 방지
// ================================
const cache = new Map();

function isDup(symbol, type) {
  const key = symbol + type;
  const now = Date.now();

  if (cache.has(key)) {
    if (now - cache.get(key) < 30 * 60 * 1000) return true;
  }

  cache.set(key, now);
  return false;
}

// ================================
// MAIN LOOP
// ================================
async function main() {
  console.log('🚀 PREMIUM BOT START');

  while (true) {
    try {
      const symbols = await getTopSymbols();

      for (let i = 0; i < symbols.length; i += CONFIG.BATCH) {
        const batch = symbols.slice(i, i + CONFIG.BATCH);

        await Promise.all(batch.map(async (s) => {
          try {

            const [fr, oi, ls, taker] = await Promise.all([
              getFunding(s.symbol),
              getOI(s.symbol),
              getLS(s.symbol),
              getTaker(s.symbol)
            ]);

            const wyckoff = detectWyckoff({ oi, ls, fr });

            const smart = smartMoneyFilter({ oi, fr });
            if (!smart) return;

            const signal = detectSignal({ fr, oi, taker, wyckoff });
            if (!signal) return;

            if (isDup(s.symbol, signal)) return;

            const msg = `
${signal} ${s.symbol}

FR: ${fr.toFixed(4)}%
OI: ${oi.toFixed(2)}%
Taker: ${taker.toFixed(2)}
LS: ${ls.toFixed(2)}

Wyckoff: ${wyckoff}
`;

            console.log(msg);
            await sendTelegram(msg);

          } catch (e) {
            console.error('symbol error:', s.symbol);
          }
        }));
      }

    } catch (e) {
      console.error('loop error:', e);
    }

    await sleep(CONFIG.INTERVAL);
  }
}

// ================================
// EXPRESS (Railway 유지)
// ================================
const app = express();
app.get('/', (req,res)=>res.send('alive'));
app.listen(CONFIG.PORT, () => console.log('🌐 server on'));

// ================================
main();
