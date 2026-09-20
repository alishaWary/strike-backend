/**
 * Strike Terminal — Dhan order/data proxy
 * ----------------------------------------
 * Sits between your phone UI and Dhan's v2 API. Holds your access token
 * and routes ORDER PLACEMENT through a static-IP proxy (from a service like
 * StaticIP.in), since Dhan requires orders to originate from a whitelisted
 * static IP. Quotes/charts/expiries don't need this and keep using Render's
 * normal connection.
 *
 * Endpoints:
 *   GET  /api/expiries?index=NIFTY|SENSEX
 *   GET  /api/live?index=NIFTY&expiry=2026-09-30&strike=24850&type=CE
 *   POST /api/order   { index, expiry, strike, type, transactionType, quantity, price, stopLossPrice }
 *
 * Env vars (set these in Render's dashboard, not in code):
 *   DHAN_CLIENT_ID
 *   DHAN_ACCESS_TOKEN
 *   PROXY_URL          — from your static IP service, format:
 *                        http://username:password@proxyhost:port
 *                        Leave unset and everything still works EXCEPT
 *                        order placement, which needs the static IP.
 *   ALLOWED_ORIGIN     (optional — restrict CORS to your frontend's URL)
 */

const express = require('express');
const cors = require('cors');
const { parse } = require('csv-parse');
const { Readable } = require('stream');
const { fetch: undiciFetch, ProxyAgent } = require('undici');

const app = express();
app.use(express.json());
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || '*' }));

const BASE = 'https://api.dhan.co/v2';
const HEADERS = () => ({
  'Content-Type': 'application/json',
  'Accept': 'application/json',
  'access-token': process.env.DHAN_ACCESS_TOKEN,
  'client-id': process.env.DHAN_CLIENT_ID
});

// Only order placement needs the static IP — build the proxy dispatcher
// once, and use it only for that call. If PROXY_URL isn't set yet, this
// stays null and order calls just go out normally (which Dhan will reject
// until you have a static IP whitelisted — everything else still works).
const proxyAgent = process.env.PROXY_URL ? new ProxyAgent(process.env.PROXY_URL) : null;

async function dhanFetch(url, options, useProxy) {
  const opts = { ...options };
  if (useProxy && proxyAgent) opts.dispatcher = proxyAgent;
  return undiciFetch(url, opts);
}

const UNDERLYING = {
  NIFTY:  { securityId: 13, segment: 'IDX_I', exchange: 'NSE_FNO' },
  SENSEX: { securityId: 51, segment: 'IDX_I', exchange: 'BSE_FNO' }
};

const filteredCache = {};

function findCol(row, ...hints) {
  const keys = Object.keys(row);
  for (const hint of hints) {
    const hit = keys.find(k => k.toUpperCase().includes(hint));
    if (hit) return hit;
  }
  return null;
}

async function loadFilteredInstruments(indexName) {
  const ONE_DAY = 24 * 60 * 60 * 1000;
  const cached = filteredCache[indexName];
  if (cached && Date.now() - cached.fetchedAt < ONE_DAY) return cached;

  const underlying = UNDERLYING[indexName];
  const res = await dhanFetch(`${BASE}/instrument/${underlying.exchange}`, {
    headers: { 'access-token': process.env.DHAN_ACCESS_TOKEN }
  }, false);
  if (!res.ok) throw new Error(`Instrument list fetch failed for ${underlying.exchange}: ${res.status}`);
  if (!res.body) throw new Error('No response body from Dhan instrument endpoint');

  const nodeStream = Readable.fromWeb(res.body);
  const parser = nodeStream.pipe(parse({ columns: true, skip_empty_lines: true }));

  let cols = null;
  const rows = [];

  for await (const record of parser) {
    if (!cols) {
      cols = {
        sym: findCol(record, 'UNDERLYING_SYMBOL', 'SYMBOL_NAME', 'SEM_TRADING_SYMBOL'),
        strike: findCol(record, 'STRIKE'),
        expiry: findCol(record, 'EXPIRY'),
        optType: findCol(record, 'OPTION_TYPE', 'OPT_TYPE'),
        id: findCol(record, 'SECURITY_ID')
      };
      if (!cols.sym || !cols.strike || !cols.expiry || !cols.optType || !cols.id) {
        throw new Error(`Could not identify instrument CSV columns for ${underlying.exchange} — check raw headers and adjust findCol() hints`);
      }
    }
    if (String(record[cols.sym]).toUpperCase().includes(indexName)) {
      rows.push(record);
    }
  }

  const entry = { rows, cols, fetchedAt: Date.now(), exchange: underlying.exchange };
  filteredCache[indexName] = entry;
  return entry;
}

async function resolveSecurityId(index, expiry, strike, type) {
  const indexName = index.toUpperCase();
  if (!UNDERLYING[indexName]) throw new Error(`Unknown index ${index}`);
  const { rows, cols, exchange } = await loadFilteredInstruments(indexName);
  if (!rows.length) throw new Error(`No ${indexName} contracts found on ${exchange} — instrument list may be empty`);

  const wantStrike = String(strike);
  const wantType = type.toUpperCase().startsWith('C') ? 'CE' : 'PE';

  const match = rows.find(r =>
    String(r[cols.expiry]).startsWith(expiry) &&
    String(parseFloat(r[cols.strike])) === String(parseFloat(wantStrike)) &&
    String(r[cols.optType]).toUpperCase().startsWith(wantType[0])
  );
  if (!match) throw new Error(`No contract found for ${index} ${expiry} ${strike}${wantType} on ${exchange}`);
  return { securityId: match[cols.id], exchange };
}

// ---- Routes ----

app.get('/api/expiries', async (req, res) => {
  try {
    const idx = UNDERLYING[req.query.index];
    if (!idx) return res.status(400).json({ error: 'index must be NIFTY or SENSEX' });
    const r = await dhanFetch(`${BASE}/optionchain/expirylist`, {
      method: 'POST',
      headers: HEADERS(),
      body: JSON.stringify({ UnderlyingScrip: idx.securityId, UnderlyingSeg: idx.segment })
    }, false);
    const data = await r.json();
    res.status(r.status).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/live', async (req, res) => {
  try {
    const { index, expiry, strike, type } = req.query;
    if (!index || !expiry || !strike || !type) {
      return res.status(400).json({ error: 'index, expiry, strike, type are required' });
    }
    const { securityId, exchange } = await resolveSecurityId(index, expiry, strike, type);

    const [ohlcRes, candleRes] = await Promise.all([
      dhanFetch(`${BASE}/marketfeed/ohlc`, {
        method: 'POST',
        headers: HEADERS(),
        body: JSON.stringify({ [exchange]: [Number(securityId)] })
      }, false),
      dhanFetch(`${BASE}/charts/intraday`, {
        method: 'POST',
        headers: HEADERS(),
        body: JSON.stringify({
          securityId: String(securityId),
          exchangeSegment: exchange,
          instrument: 'OPTIDX',
          interval: '1',
          fromDate: new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' '),
          toDate: new Date().toISOString().slice(0, 19).replace('T', ' ')
        })
      }, false)
    ]);
    const ohlc = await ohlcRes.json();
    const candles = await candleRes.json();
    res.json({ securityId, exchange, ohlc, candles });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// The one call that needs the static IP — routed through the proxy when
// PROXY_URL is configured.
app.post('/api/order', async (req, res) => {
  try {
    if (!proxyAgent) {
      return res.status(400).json({ error: 'PROXY_URL is not set yet — order placement needs your static IP proxy configured first. Quotes and charts work fine without it.' });
    }
    const { index, expiry, strike, type, transactionType, quantity, price, stopLossPrice } = req.body;
    if (!index || !expiry || !strike || !type || !quantity || !price || !stopLossPrice) {
      return res.status(400).json({ error: 'index, expiry, strike, type, quantity, price, stopLossPrice are required' });
    }
    const { securityId, exchange } = await resolveSecurityId(index, expiry, strike, type);

    const orderPayload = {
      dhanClientId: process.env.DHAN_CLIENT_ID,
      correlationId: `st-${Date.now()}`,
      transactionType: transactionType || 'BUY',
      exchangeSegment: exchange,
      productType: 'CO',
      orderType: 'LIMIT',
      securityId: String(securityId),
      quantity: Number(quantity),
      price: Number(price),
      stopLossPrice: Number(stopLossPrice)
    };

    const r = await dhanFetch(`${BASE}/super/orders`, {
      method: 'POST',
      headers: HEADERS(),
      body: JSON.stringify(orderPayload)
    }, true); // <-- routed through the static IP proxy
    const data = await r.json();
    res.status(r.status).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/health', (req, res) => res.json({ ok: true, proxyConfigured: !!proxyAgent }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Strike Terminal backend listening on ${PORT} (proxy: ${proxyAgent ? 'configured' : 'not set'})`));
AN_CLIENT_ID,
      correlationId: `st-${Date.now()}`,
      transactionType: transactionType || 'BUY',
      exchangeSegment: exchange,
      productType: 'CO',
      orderType: 'LIMIT',
      securityId: String(securityId),
      quantity: Number(quantity),
      price: Number(price),
      stopLossPrice: Number(stopLossPrice)
    };

    const r = await fetch(`${BASE}/super/orders`, {
      method: 'POST',
      headers: HEADERS(),
      body: JSON.stringify(orderPayload)
    });
    const data = await r.json();
    res.status(r.status).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Strike Terminal backend listening on ${PORT}`));

