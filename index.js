// ================================
// IMPORT
// ================================
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const fetch = require('node-fetch');
import express from 'express';

// ================================
// CONFIG
// ================================
const CONFIG = {
  API: 'https://fapi.binance.com',
  TOP_N: 40,
  BATCH: 5,
  INTERVAL: 45000, // 45초
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
        console.error(`fetch failed for ${url}`, e);
        return null; // 실패 시 null 반환, 루프 멈추지 않음
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
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ chat_id: CONFIG.CHAT_ID, text: msg, parse_mode: 'HTML' })
    });
  } catch (e) {
    console.error('텔레그램 전송 실패', e);
  }
}

// ================================
// API FUNCTIONS
// ================================
async function getTopSymbols() {
  const data = await safeFetch(`${CONFIG.API}/fapi/v1/ticker/24hr`);
  if (!data) return [];
  return data
    .filter(x => x.symbol.endsWith('USDT') && +x.quoteVolume > 10000000)
    .sort((a,b) => +b.quoteVolume - +a.quoteVolume)
    .slice(0, CONFIG.TOP_N)
    .map(x => ({ symbol: x.symbol, pricePct: +parseFloat(x.priceChangePercent) }));
}

async function getFunding(symbol) {
  const d = await safeFetch(`${CONFIG.API}/fapi/v1/premiumIndex?symbol=${symbol}`);
  return d ? parseFloat(d.lastFundingRate) * 100 : 0;
}

async function getOI(symbol) {
  const d = await safeFetch(`${CONFIG.API}/futures/data/openInterestHist?symbol=${symbol}&period=1h&limit=5`);
  if (!d || !d.length) return 0;
  const vals = d.map(x => +x.sumOpenInterestValue);
  return ((vals.at(-1) - vals[0]) / vals[0]) * 100;
}

async function getLS(symbol) {
  const d = await safeFetch(`${CONFIG.API}/futures/data/globalLongShortAccountRatio?symbol=${symbol}&period=1h&limit=1`);
  return d && d.length ? parseFloat(d[0].longShortRatio) : 1;
}

async function getTaker(symbol) {
  const d = await safeFetch(`${CONFIG.API}/futures/data/takerlongshortRatio?symbol=${symbol}&period=1h&limit=5`);
  if (!d || !d.length) return 1;
  const vals = d.map(x => parseFloat(x.buySellRatio));
  return vals.reduce((a,b)=>a+b,0)/vals.length;
}

// ================================
// WYCKOFF
// ================================
function detectWyckoff({ pricePct, oi, ls, fr }) {
  const sideways = Math.abs(pricePct) < 1.5;
  if (sideways && oi > 5 && ls < 0.8 && fr < -0.02) return 'ACCUMULATION';
  if (sideways && oi > 5 && ls > 1.8 && fr > 0.02) return 'DISTRIBUTION';
  return 'NONE';
}

// ================================
// SIGNAL
// ================================
function detectSignal({ fr, oi, taker, wyckoff }) {
  if (fr < -0.04 && oi > 5 && taker > 1.15 && wyckoff === 'ACCUMULATION') return '🚀 LONG';
  if (fr > 0.04 && oi > 5 && taker < 0.85 && wyckoff === 'DISTRIBUTION') return '🔻 SHORT';
  return null;
}

// ================================
// DUPLICATE
// ================================
const cache = new Map();
function isDup(symbol, type) {
  const key = symbol + type;
  const now = Date.now();
  if (cache.has(key) && (now - cache.get(key) < 30*60*1000)) return true;
  cache.set(key, now);
  return false;
}

// ================================
// MAIN LOOP
// ================================
async function main() {
  console.log('🚀 BOT STARTED');

  while (true) {
    try {
      console.log('🔄 scanning...');
      const symbols = await getTopSymbols();

      if (!symbols.length) {
        console.log('심볼 없음, 1분 대기');
        await sleep(60000);
        continue;
      }

      for (let i = 0; i < symbols.length; i += CONFIG.BATCH) {
        const batch = symbols.slice(i, i + CONFIG.BATCH);

        await Promise.all(batch.map(async s => {
          try {
            const [fr, oi, ls, taker] = await Promise.all([
              getFunding(s.symbol),
              getOI(s.symbol),
              getLS(s.symbol),
              getTaker(s.symbol)
            ]);

            const wyckoff = detectWyckoff({ pricePct: s.pricePct, oi, ls, fr });
            const signal = detectSignal({ fr, oi, taker, wyckoff });

            const msg = `
${signal || '-'} ${s.symbol}
FR: ${fr.toFixed(4)}%
OI: ${oi.toFixed(2)}%
Taker: ${taker.toFixed(2)}
LS: ${ls.toFixed(2)}
Wyckoff: ${wyckoff}
`;
            console.log(msg);

            if (signal && !isDup(s.symbol, signal)) await sendTelegram(msg);

          } catch (e) {
            console.error('symbol error:', s.symbol, e);
          }
        }));
      }

    } catch (e) {
      console.error('loop error:', e);
    }

    console.log('⏳ sleep...\n');
    await sleep(CONFIG.INTERVAL);
  }
}

// ================================
// EXPRESS PING SERVER (Keep Alive)
// ================================
const app = express();
app.get('/ping', (req,res)=>res.send('pong'));
app.listen(CONFIG.PORT, () => console.log(`🌐 Ping server running on port ${CONFIG.PORT}`));

// ================================
main();
