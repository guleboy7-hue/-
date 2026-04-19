# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Binance Futures trading bot that scans the top 20 USDT perpetual pairs by 24h volume every 2 minutes, detects smart-money accumulation/distribution patterns, and sends Telegram alerts.

## Running the Bot

```bash
npm start        # runs node index.js
```

No build step, no test suite, no linter is configured.

## Architecture

Single-file Node.js app (`index.js`, ~239 lines) divided into clearly commented sections:

1. **CONFIG** – All tuneable parameters in one object (API base URL, `TOP_N`, `BATCH`, `INTERVAL`, Telegram credentials, `TIMEOUT`, `RETRY`, `PORT`).
2. **Express server** – Minimal HTTP server (default port 3000) required for hosting platforms; exposes a single health-check route.
3. **Utils** – `safeFetch(url)` wraps `node-fetch` with 10 s timeout and up to 3 retries; `sleep(ms)` is a plain delay helper.
4. **Telegram** – `sendTelegram(msg)` formats and POSTs trade-signal messages to the configured chat.
5. **Binance API layer** – Five thin wrappers (`getTopSymbols`, `getFunding`, `getOI`, `getLS`, `getTaker`) that call `fapi.binance.com` public endpoints.
6. **Signal detection** – `detectWyckoff()` classifies candle data as accumulation / distribution / none; `smartMoneyFilter()` applies conviction thresholds; `detectSignal()` combines all indicators to emit `PREMIUM LONG` or `PREMIUM SHORT`.
7. **Duplicate guard** – In-memory `Map` prevents re-alerting the same symbol within 30 minutes.
8. **Main loop** – `scan()` fetches top symbols, processes them in batches of 3 (rate-limit safety), runs all four indicator fetches in parallel per symbol, then fires alerts.

### Signal logic

| Signal | Wyckoff | Funding | OI change | Taker ratio |
|--------|---------|---------|-----------|-------------|
| PREMIUM LONG | accumulation | negative | high | bullish |
| PREMIUM SHORT | distribution | positive | high | bearish |

## Key Conventions

- **All configuration lives in the `CONFIG` object** at the top of `index.js`. Change scanning behaviour (interval, batch size, symbol count) there.
- Credentials (`TELEGRAM_TOKEN`, `CHAT_ID`) are currently hardcoded in `CONFIG`. Move them to environment variables before deploying publicly.
- `node-fetch` v3 is ESM-only; the project uses CommonJS `require`. Pin to the version in `package.json` or switch to the native `fetch` available in Node ≥ 18 before upgrading.
- Batching (`BATCH: 3`) exists specifically to avoid Binance rate limits — do not remove or raise it without testing.
