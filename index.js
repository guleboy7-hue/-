// ================================
// REQUIRE 대신 createRequire
// ================================
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const fetch = require('node-fetch');

// ================================
// CONFIG
// ================================
const CONFIG = {
  API: 'https://fapi.binance.com',
  TOP_N: 40,
  BATCH: 5,
  INTERVAL: 45000, // 45초 스캔
  TELEGRAM_TOKEN: '8650566978:AAH2273LrbNTjmtsIvPLTALVz-6wgSi4n3Y',
  CHAT_ID: '6363226823',
  TIMEOUT: 10000,
  RETRY: 3
};

// ================================
// GLOBAL SAFE GUARD
// ================================
process.on('uncaughtException', err => console.error('🔥 UNCAUGHT:', err));
process.on('unhandledRejection', err => console.error('🔥 REJECTION:', err));

// ================================
// UTILS
// ================================
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

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
      if (i === retry - 1) throw e;
      await sleep(1000);
    }
  }
}

// ================================
// TELEGRAM
// ================================
async function sendTelegram(msg) {
  try {
    await fetch(`https://api.telegram.org/bot${CONFIG.TELEGRAM_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({
        chat_id: CONFIG.CHAT_ID,
        text: msg,
        parse_mode: 'HTML'
      })
    });
  } catch (e) {
    console.error('텔레그램 실패', e);
  }
}

// ================================
// API
// ================================
async function getTopSymbols() {
  const data = await safeFetch(`${CONFIG.API}/fapi/v1/ticker/24hr`);
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
  return parseFloat(d.lastFundingRate) * 100;
}

async function getOI(symbol) {
  const d = await safeFetch(`${CONFIG.API}/futures/data/openInterestHist?symbol=${symbol}&period=1h&limit=5`);
  if (!d.length) return 0;
  const vals = d.map(x => +x.sumOpenInterestValue);
  return ((vals.at(-1) - vals[0]) / vals[0]) * 100;
}

async function getLS(symbol) {
  const d = await safeFetch(`${CONFIG.API}/futures/data/globalLongShortAccountRatio?symbol=${symbol}&period=1h&limit=1`);
  return d.length ? parseFloat(d[0].longShortRatio) : 1;
}

async function getTaker(symbol) {
  const d = await safeFetch(`${CONFIG.API}/futures/data/takerlongshortRatio?symbol=${symbol}&period=1h&limit=5`);
  if (!d.length) return 1;
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
  if (fr < -0.04 && oi > 5 && taker > 1.15 && wyckoff === 'ACCUMULATION')
    return '🚀 LONG';
  if (fr > 0.04 && oi > 5 && taker < 0.85 && wyckoff === 'DISTRIBUTION')
    return '🔻 SHORT';
  return null;
}

// ================================
// DUPLICATE
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
// LOOP + LOGGING
// ================================
async function main() {
  console.log('🚀 BOT STARTED');

  while (true) {
    try {
      console.log('🔄 scanning...');
      const symbols = await getTopSymbols();

      const results = await Promise.all(symbols.map(async s => {
        try {
          const [fr, oi, ls, taker] = await Promise.all([
            getFunding(s.symbol),
            getOI(s.symbol),
            getLS(s.symbol),
            getTaker(s.symbol)
          ]);

          const wyckoff = detectWyckoff({ pricePct: s.pricePct, oi, ls, fr });
          const signal = detectSignal({ fr, oi, taker, wyckoff });

          return { symbol: s.symbol, fr, oi, ls, taker, wyckoff, signal };

        } catch (e) {
          console.error('symbol error:', s.symbol, e);
          return null;
        }
      }));

      // 콘솔 테이블 출력
      console.table(results.filter(r => r !== null).map(r => ({
        Symbol: r.symbol,
        FR: r.fr.toFixed(4),
        OI: r.oi.toFixed(2),
        LS: r.ls.toFixed(2),
        Taker: r.taker.toFixed(2),
        Wyckoff: r.wyckoff,
        Signal: r.signal || '-'
      })));

      // Telegram 전송
      for (const r of results) {
        if (!r || !r.signal) continue;
        if (isDup(r.symbol, r.signal)) continue;

        const msg = `
${r.signal} ${r.symbol}

FR: ${r.fr.toFixed(4)}%
OI: ${r.oi.toFixed(2)}%
Taker: ${r.taker.toFixed(2)}
LS: ${r.ls.toFixed(2)}

Wyckoff: ${r.wyckoff}
`;
        await sendTelegram(msg);
      }

    } catch (e) {
      console.error('loop error:', e);
    }

    console.log('⏳ sleep...\n');
    await sleep(CONFIG.INTERVAL);
  }
}

// ================================
main();
