# Mini Golf sync server

A small Cloudflare Worker that lets two phones play without texting a link every
turn. It stores each game (the same encoded state the app puts in links), and
when it becomes your turn it sends a push notification like "Alex played you
back!", unless your app checked in within the last 15 seconds (it's open).

- One Durable Object per game keeps the newest state, each player's push
  subscriptions, and when each player's app last checked in.
- Push notifications are standard Web Push (VAPID). The signing keys are created
  by the server on first use and stored in it, so there are no secrets to set.
- Runs on Cloudflare's free plan.

## Deploying (GitHub Action)

The workflow in `.github/workflows/deploy-server.yml` deploys this folder
whenever it changes on `main`, or when you run it from the Actions tab.

1. Create a free account at cloudflare.com. Open **Workers & Pages** once so it
   sets up your `workers.dev` subdomain.
2. Create an API token: **My Profile → API Tokens → Create Token**, use the
   **Edit Cloudflare Workers** template, and create it.
3. Copy your **Account ID** (shown on the Workers & Pages overview page).
4. In the GitHub repo: **Settings → Secrets and variables → Actions → New
   repository secret**. Add `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
5. Run **Actions → Deploy sync server → Run workflow**. The run summary shows the
   server address, e.g. `https://minigolf-sync.<you>.workers.dev`.
6. Put that address in `config.js` (`window.MINIGOLF_SERVER`) on `main`.

## Running locally

```sh
cd server
npm install
npm run dev        # http://localhost:8787, allows http:// push endpoints for testing
```

Then set `window.MINIGOLF_SERVER = 'http://localhost:8787'` in `config.js` and
serve the game from `http://localhost` (service workers need https or localhost).

## API

| Method | Path | Body / query | Result |
|---|---|---|---|
| GET | `/api/vapid` | | `{ publicKey }` for `pushManager.subscribe` |
| GET | `/api/game/:id` | `?p=0\|1` marks that player's app as open | `{ code, seq, next }` |
| PUT | `/api/game/:id` | `{ code, seq, notify?: { to, body, url }, from? }` | `{ ok, seq }`, or 409 with the newer state |
| POST | `/api/game/:id/subscribe` | `{ p, subscription }` | `{ ok }` |
| POST | `/api/game/:id/next` | `{ next }` (rematch) | `{ ok }` |
