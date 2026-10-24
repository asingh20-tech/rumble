# RUMBLE

**Your phone is the controller. Your friends are the enemies.**

A laptop shows a shared neon arena. Players scan a QR code, join from iPhone Safari, tilt to
move, shake to charge a shockwave, and press ATTACK to knock opponents off the platform.
Last one standing wins. No app install, no accounts.

## Repo layout

npm workspaces, ESM everywhere:

| Workspace | What it is |
| --- | --- |
| `shared/` | `@rumble/shared`: `protocol.js` (socket events, payloads, error codes) and `constants.js` (game rules) |
| `server/` | Node + Express + Socket.IO. Server-authoritative game state, in memory |
| `client/` | React + Vite + Tailwind + Phaser. Host screen (`/host`) and phone controller (`/play/:code`) |

Root scripts:

- `npm run dev`: server (`:3001`) and client (`:5173`) together
- `npm test`: Vitest in every workspace
- `npm run build`: production build of the client into `client/dist`

## Run locally + iPhone tunnel

iPhones need **HTTPS** for motion sensors, and they can't reach your Mac's `localhost`. Venue
Wi-Fi often blocks device-to-device traffic too. So we expose the Vite dev server through a
Cloudflare quick tunnel. Vite proxies `/socket.io` to the backend, so the page and the socket
share one HTTPS origin.

Requires Node 22.9+ (`node -v`).

```bash
# one-time setup
brew install cloudflared
npm install

# optional: copy env files (defaults work without them)
cp server/.env.example server/.env
cp client/.env.example client/.env.local

# terminal 1: server + client
npm run dev

# terminal 2: public HTTPS URL for phones
cloudflared tunnel --url http://localhost:5173
```

`cloudflared` prints a URL like `https://random-words.trycloudflare.com`.

1. On the **laptop**, open `https://<random-words>.trycloudflare.com/host`. Use the tunnel
   URL, not `localhost`, so the QR code encodes an address phones can reach.
2. On each **iPhone**, scan the QR code with the Camera app and open it in Safari.

Notes:

- The tunnel URL changes every time you restart `cloudflared`.
- Health check: `curl http://localhost:3001/health` → `{"ok":true}`.
- `npm run dev` sets `NODE_ENV=development`, so a round can start with `DEV_MIN_PLAYERS`
  (default 1) instead of `MIN_PLAYERS` (default 4).

## Environment variables

**server/.env**: `PORT` (3001), `CLIENT_ORIGIN` (comma-separated allowed origins, default
`http://localhost:5173`), `MIN_PLAYERS` (4), `MAX_PLAYERS` (8, capped at 8),
`DEV_MIN_PLAYERS` (1).

**client/.env.local**: `VITE_SERVER_URL` (empty = same origin via the Vite proxy; set to the
backend URL in production) and `VITE_PUBLIC_URL` (empty = `window.location.origin`; base URL
for the join QR code).

## Production

Frontend on Vercel (`npm run build`, output `client/dist`). Backend on Render or Railway
(`npm start -w server`) with `CLIENT_ORIGIN` set to the Vercel URL. Set `VITE_SERVER_URL`
and `VITE_PUBLIC_URL` in Vercel.
