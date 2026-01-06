# polymarket-scanner
A scanner bot for Polymarket, built as a Cloudflare Worker with static assets served from `public/`.

## Deployment (Cloudflare Workers)
This project deploys as a Worker using `wrangler.jsonc`.

### Routes
- `/api/gamma/*` → proxied to `https://gamma-api.polymarket.com/*` (GET only)
- `/api/clob/*` → proxied to `https://clob.polymarket.com/*` (GET/POST only)
- `/api/trade/execute` → order execution endpoint (POST)

### Setup
1. Install Wrangler: `npm install -g wrangler`
2. Configure secrets as needed:
   - `POLYMARKET_PRIVATE_KEY`
   - `POLYMARKET_API_KEY`
   - `POLYMARKET_API_SECRET`
   - `POLYMARKET_API_PASSPHRASE`
3. Deploy:
   - `wrangler deploy`
