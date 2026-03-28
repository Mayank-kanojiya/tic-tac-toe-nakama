# Multiplayer Tic-Tac-Toe (Nakama)

Server-authoritative multiplayer Tic-Tac-Toe with real-time matchmaking, leaderboard, bot opponents, and a 3-round series system.

## Tech Stack

- **Frontend:** React + Vite + TypeScript (`frontend/`)
- **Backend:** Nakama 3.22 + PostgreSQL 15 via Docker Compose
- **Game logic:** 100% server-side in `nakama/data/modules/index.js`

## Features

### Core
- ✅ Server-authoritative move validation (no client cheating possible)
- ✅ Real-time state broadcast via Nakama WebSocket
- ✅ Player disconnect detection (`opponent_left` result)
- ✅ Multiple concurrent isolated game sessions (Nakama handles natively)

### Matchmaking
- ✅ **Quick Match** — Nakama built-in matchmaker pairs players automatically
- ✅ **Private Match** — create a room and share the Match ID
- ✅ **Join by ID** — paste a Match ID to join a specific room
- ✅ Mode selection (Classic / Timed 30s) before matchmaking

### Game Modes
- ✅ **Classic** — no turn timer
- ✅ **Timed** — 30-second turn timer, server-authoritative countdown, auto-forfeit on timeout
- ✅ **vs Bot** — Easy (random) / Medium (block/win heuristic) / Hard (minimax, unbeatable)

### Series & Scoring
- ✅ Best-of-3 series with round tracking
- ✅ +10 points per round win, tracked server-side
- ✅ Symbols swap each round for fairness
- ✅ Post-round popup with scores and Next Round / Exit to Lobby (synchronized between players)

### Leaderboard
- ✅ Scores persisted to Nakama leaderboard storage on series end
- ✅ Global leaderboard accessible from lobby (`get_leaderboard` RPC)
- ✅ Player's own row highlighted

## Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/)
- Node.js 18+ and [pnpm](https://pnpm.io/)

## Run Locally

### 1. Start Nakama + PostgreSQL

```bash
docker compose up
```

Nakama endpoints:
- HTTP API: `http://127.0.0.1:7350`
- gRPC: `127.0.0.1:7351`
- Console: `http://127.0.0.1:7351` (admin: `admin` / `password`)

### 2. Start the frontend

```bash
pnpm -C frontend install
pnpm -C frontend dev
```

Open `http://localhost:5173`

## How to Play

### Multiplayer (Quick Match)
1. Open `http://localhost:5173` in two browser windows (or one normal + one incognito).
2. Enter a username in each.
3. Select a mode (Classic or Timed 30s).
4. Click **⚡ Quick Match** in both windows — Nakama pairs them automatically.

### Multiplayer (Private Match)
1. Window A: click **Create Private Match** → copy the Match ID shown.
2. Window B: paste the ID → click **Join Match**.

### vs Bot
1. Select difficulty (Easy / Medium / Hard).
2. Click **Play vs Bot**.

## Deployment

### Docker Compose (self-hosted / cloud VM)

The included `docker-compose.yml` is production-ready. To deploy on any Linux VM (AWS EC2, GCP Compute Engine, DigitalOcean Droplet, etc.):

```bash
# On the server
git clone <repo>
cd tic-tac-toe-nakama
docker compose up -d
```

Then build and serve the frontend:

```bash
pnpm -C frontend install
VITE_NAKAMA_HOST=<your-server-ip> pnpm -C frontend build
# Serve frontend/dist with nginx, Caddy, or any static host
```

### Environment Variables (frontend)

| Variable | Default | Description |
|---|---|---|
| `VITE_NAKAMA_HOST` | `127.0.0.1` | Nakama server hostname or IP |
| `VITE_NAKAMA_PORT` | `7350` | Nakama HTTP port |
| `VITE_NAKAMA_USE_SSL` | `false` | Set `true` when using HTTPS/WSS |
| `VITE_NAKAMA_SERVER_KEY` | `defaultkey` | Nakama server key |

Create a `frontend/.env` file:

```env
VITE_NAKAMA_HOST=your.server.com
VITE_NAKAMA_PORT=7350
VITE_NAKAMA_USE_SSL=true
VITE_NAKAMA_SERVER_KEY=defaultkey
```

## Architecture

```
Browser (React)
    │  WebSocket (Nakama JS SDK)
    ▼
Nakama Server  ──  PostgreSQL
    │
    └── ttt_match handler (index.js)
            matchInit        — initialise board, scores, mode
            matchJoinAttempt — enforce 2-player limit
            matchJoin        — assign symbols, start game
            matchLeave       — detect disconnect, award win
            matchLoop        — validate moves, run timer, bot AI,
                               handle next-round/exit votes,
                               persist scores to leaderboard
```

## Opcodes

| Opcode | Direction | Purpose |
|---|---|---|
| 1 `STATE` | Server → Client | Full game state broadcast |
| 2 `MOVE` | Client → Server | Player move (cell index) |
| 3 `ERROR` | Server → Client | Validation error message |
| 4 `NEXT_ROUND` | Client → Server | Vote to start next round |
| 5 `EXIT` | Client → Server | Vote to exit to lobby |

## RPCs

| RPC | Purpose |
|---|---|
| `create_ttt_match` | Create a new match room |
| `create_bot_match` | Create a bot match room |
| `get_leaderboard` | Fetch top-20 global scores |
