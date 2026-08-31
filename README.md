# Strike Terminal backend

Proxies your phone UI to Dhan's v2 API. Holds your access token and (once
purchased) your whitelisted static IP — never put these in the frontend.

## Deploy from your phone (no laptop)

1. **GitHub app** (or github.com in your phone browser) → create a new repo,
   e.g. `strike-terminal-backend` → upload `server.js`, `package.json`,
   this `README.md`.
2. **Render.com** → sign in with GitHub → New → Web Service → pick the repo.
   - Build command: `npm install`
   - Start command: `npm start`
3. In Render's dashboard → Environment → add:
   - `DHAN_CLIENT_ID` — your Dhan client ID
   - `DHAN_ACCESS_TOKEN` — from web.dhan.co → DhanHQ Trading APIs
   - `ALLOWED_ORIGIN` — leave blank for now, or set once you know your frontend's URL
4. Deploy. Render gives you a URL like `https://strike-terminal-backend.onrender.com`.
   Paste that into the terminal's ⚙ Settings as the backend endpoint.

## About the static IP

Dhan's **order placement** endpoint (`/v2/orders`) requires a static IP
whitelisted on your Dhan account — this is enforced by Dhan, not something
this backend can route around. Market data (quotes, charts, expiries) does
not need it, so the chart and strike selection will work as soon as this
backend is deployed; only the "Send to broker" step needs the IP.

Once you buy a static IP (Render/Railway offer this as an add-on, or use a
small VPS with a fixed IP):
1. Add the IP in Dhan Web → DhanHQ Trading APIs → IP Whitelisting.
2. Point the deployment's outbound traffic through that IP (Render's static
   IP add-on does this automatically; a VPS just has one).

## Verify the instrument CSV columns

`resolveSecurityId()` in `server.js` guesses column names from Dhan's
`/v2/instrument/NSE_FNO` CSV export (`SYMBOL`, `STRIKE`, `EXPIRY`,
`OPTION_TYPE`, `SECURITY_ID` style headers). Column names in Dhan's exports
have changed before — the first time you run this, check Render's logs for
errors from `resolveSecurityId`, and if it can't find a column, fetch
`https://api.dhan.co/v2/instrument/NSE_FNO` yourself (with your access-token
header) and adjust the `findCol()` hints in `server.js` to match the real
headers.
