/**
 * Strike Terminal — Dhan order/data proxy
 * ----------------------------------------
 * Sits between your phone UI and Dhan's v2 API. Holds your access token
 * and (once you buy it) the whitelisted static IP that Dhan requires for
 * order placement. Never ship DHAN_ACCESS_TOKEN to the browser.
 *
 * Endpoints:
 *   GET  /api/expiries?index=NIFTY|SENSEX
 *   GET  /api/live?index=NIFTY&expiry=2026-09-30&strike=24850&type=CE
 *   POST /api/order        { index, expiry, strike, type, transactionType, quantity, orderType, price, triggerPrice }
 *
 * Env vars (set these in Render/Railway's dashboard, not in code):
 *   DHAN_CLIENT_ID
 *   DHAN_ACCESS_TOKEN
 *   ALLOWED_ORIGIN     (optional — restrict CORS to your frontend's URL)
 */

const express = require('express');
const cors = require('cors');
const { parse } = require('csv-parse/sync');

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

// Dhan's IDX_I security IDs for the underlying indices (used for option-chain
// and expiry-list lookups). Confirm these still match Dhan's instrument list
// before relying on them — index security IDs have shifted before.
const UNDERLYING = {
  NIFTY:  { securityId: 13, segment: 'IDX_I' },
  SENSEX: { securityId: 51, segment: 'IDX_I' }
};

// ---- Instrument master cache (maps index+expiry+strike+type -> securityId) ----
let instrumentCache = { rows: null, fetchedAt: 0 };

async function loadInstruments() {
  const ONE_DAY = 24 * 60 * 60 * 1000;
  if (instrumentCache.rows && Date.now() - instrumentCache.fetchedAt < ONE_DAY) {
    return instrumentCache.rows;
  }
  const res = await fetch(`${BASE}/instrument/NSE_FNO`, {
    headers: { 'access-token': process.env.DHAN_ACCESS_TOKEN }
  });
  if (!res.ok) throw new Error(`Instrument list fetch failed: ${res.status}`);
  const csvText = await res.text();
  const rows = parse(csvText, { columns: true, skip_empty_lines: true });
  instrumentCache = { rows, fetchedAt: Date.now() };
  return rows;
}

// Column names in Dhan's instrument CSV have varied across exports, so match
// loosely by intent instead of hardcoding exact headers.
function findCol(row, ...hints) {
  const keys = Object.keys(row);
  for (const hint of hints) {
    const hit = keys.find(k => k.toUpperCase().includes(hint));
    if (hit) return hit;
  }
  return null;
}

async function resolveSecurityId(index, expiry, strike, type) {
  const rows = await loadInstruments();
  if (!rows.length) throw new Error('Instrument list empty');
  const sample = rows[0];
  const symCol = findCol(sample, 'UNDERLYING_SYMBOL', 'SYMBOL_NAME', 'SEM_TRADING_SYMBOL');
  const strikeCol = findCol(sample, 'STRIKE');
  const expiryCol = findCol(sample, 'EXPIRY');
  const optTypeCol = findCol(sample, 'OPTION_TYPE', 'OPT_TYPE');
  const idCol = findCol(sample, 'SECURITY_ID');
  if (!symCol || !strikeCol || !expiryCol || !optTypeCol || !idCol) {
    throw new Error('Could not identify instrument CSV columns — inspect the raw CSV headers and adjust findCol() hints');
  }
  const wantSymbol = index.toUpperCase();
  const wantExpiry = expiry; // 'YYYY-MM-DD'
  const wantStrike = String(strike);
  const wantType = type.toUpperCase().startsWith('C') ? 'CE' : 'PE';

  const match = rows.find(r =>
    String(r[symCol]).toUpperCase().includes(wantSymbol) &&
    String(r[expiryCol]).startsWith(wantExpiry) &&
    String(parseFloat(r[strikeCol])) === String(parseFloat(wantStrike)) &&
    String(r[optTypeCol]).toUpperCase().startsWith(wantType[0])
  );
  if (!match) throw new Error(`No contract found for ${index} ${expiry} ${strike}${wantType}`);
  return match[idCol];
}

// ---- Routes ----

app.get('/api/expiries', async (req, res) => {
  try {
    const idx = UNDERLYING[req.query.index];
    if (!idx) return res.status(400).json({ error: 'index must be NIFTY or SENSEX' });
    const r = await fetch(`${BASE}/optionchain/expirylist`, {
      method: 'POST',
      headers: HEADERS(),
      body: JSON.stringify({ UnderlyingScrip: idx.securityId, UnderlyingSeg: idx.segment })
    });
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
    const securityId = await resolveSecurityId(index, expiry, strike, type);

    const [ohlcRes, candleRes] = await Promise.all([
      fetch(`${BASE}/marketfeed/ohlc`, {
        method: 'POST',
        headers: HEADERS(),
        body: JSON.stringify({ NSE_FNO: [Number(securityId)] })
      }),
      fetch(`${BASE}/charts/intraday`, {
        method: 'POST',
        headers: HEADERS(),
        body: JSON.stringify({
          securityId: String(securityId),
          exchangeSegment: 'NSE_FNO',
          instrument: 'OPTIDX',
          interval: '1',
          fromDate: new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' '),
          toDate: new Date().toISOString().slice(0, 19).replace('T', ' ')
        })
      })
    ]);
    const ohlc = await ohlcRes.json();
    const candles = await candleRes.json();
    res.json({ securityId, ohlc, candles });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/order', async (req, res) => {
  try {
    const { index, expiry, strike, type, transactionType, quantity, orderType, price, triggerPrice } = req.body;
    if (!index || !expiry || !strike || !type || !quantity) {
      return res.status(400).json({ error: 'index, expiry, strike, type, quantity are required' });
    }
    const securityId = await resolveSecurityId(index, expiry, strike, type);

    const orderPayload = {
      dhanClientId: process.env.DHAN_CLIENT_ID,
      correlationId: `st-${Date.now()}`,
      transactionType: transactionType || 'BUY',
      exchangeSegment: 'NSE_FNO',
      productType: 'INTRADAY',
      orderType: orderType || 'MARKET',
      validity: 'DAY',
      securityId: String(securityId),
      quantity: String(quantity),
      price: price ? String(price) : '',
      triggerPrice: triggerPrice ? String(triggerPrice) : ''
    };

    const r = await fetch(`${BASE}/orders`, {
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
