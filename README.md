# Multiplayer Tic-Tac-Toe

A production-ready, server-authoritative multiplayer Tic-Tac-Toe game built with React and Nakama. All game logic runs on the server — clients only send move intents and render the state they receive back.

---

## Table of Contents

1. [Tech Stack](#tech-stack)
2. [Setup & Installation](#setup--installation)
3. [Architecture & Design Decisions](#architecture--design-decisions)
4. [Features](#features)
5. [API & Server Configuration](#api--server-configuration)
6. [Deployment](#deployment)
7. [Testing Multiplayer](#testing-multiplayer)

---

## Tech Stack

| Layer | Technology | Version |
|---|---|---|
| Frontend | React + Vite + TypeScript | React 19, Vite 8 |
| Backend runtime | Nakama (JavaScript runtime) | 3.22.0 |
| Database | PostgreSQL | 15 |
| Infrastructure | Docker Compose | — |
| Nakama JS SDK | `@heroiclabs/nakama-js` | 2.8.x |

---

## Setup & Installation

### Prerequisites

| Tool | Minimum version | Install |
|---|---|---|
| Docker Desktop | 4.x | https://www.docker.com/products/docker-desktop |
| Node.js | 18.x | https://nodejs.org |
| pnpm | 8.x | `npm install -g pnpm` |

### 1. Clone the repository

```bash
git clone <repo-url>
cd tic-tac-toe-nakama
```

### 2. Start the backend (Nakama + PostgreSQL)

```bash
docker compose up
```

Docker Compose will:
- Start a PostgreSQL 15 container and wait for it to be healthy
- Run Nakama database migrations automatically
- Start the Nakama server with the game module loaded from `nakama/data/modules/index.js`

Wait until you see this line in the logs before proceeding:

```
{"msg":"Startup done"}
```

Verify the module loaded correctly — you should see these lines:

```
{"msg":"ttt module loaded"}
{"msg":"Registered JavaScript runtime RPC function invocation","id":"create_ttt_match"}
{"msg":"Registered JavaScript runtime RPC function invocation","id":"create_bot_match"}
{"msg":"Registered JavaScript runtime RPC function invocation","id":"get_leaderboard"}
{"msg":"Registered JavaScript runtime RPC function invocation","id":"quick_match"}
{"msg":"Registered JavaScript runtime RPC function invocation","id":"get_quick_match_stats"}
```

### 3. Start the frontend

In a new terminal:

```bash
pnpm -C frontend install
pnpm -C frontend dev
```

Open **http://localhost:5173** in your browser.

### 4. Verify everything is working

1. Open http://localhost:5173
2. Enter a username and click **Play**
3. Select **Play vs Bot** — if the board appears and the bot makes a move within 2 seconds, the full stack is working correctly

### Stopping the stack

```bash
docker compose down          # stop containers, keep data
docker compose down -v       # stop containers and delete all data
```

---

## Architecture & Design Decisions

### Overview

```
Browser (React + Vite)
    │
    │  HTTP REST  ──  RPC calls (create match, leaderboard)
    │  WebSocket  ──  real-time match state, moves, votes
    │
    ▼
Nakama 3.22 Server
    │
    ├── JavaScript runtime  ──  index.js (all game logic)
    │       matchInit            initialise board, scores, mode, bot config
    │       matchJoinAttempt     enforce 2-player limit
    │       matchJoin            assign symbols, start game, broadcast state
    │       matchLeave           detect disconnect, award win
    │       matchLoop            validate moves, timer, bot AI, votes, scores
    │
    └── PostgreSQL 15  ──  sessions, leaderboard, storage
```

### Key Design Decisions

#### 1. Server-authoritative match handler

All game state lives inside Nakama's authoritative match handler (`matchLoop`). The client never modifies the board directly — it sends a move opcode with a cell index, and the server validates it, applies it, checks for win/draw, and broadcasts the new state to all players. This prevents any client-side cheating.

#### 2. Single-file server module

All server logic is in one file (`nakama/data/modules/index.js`) using Nakama's JavaScript runtime (Duktape engine). This keeps the backend self-contained and easy to reason about without a build step.

#### 3. Clock-skew-safe timer

The 30-second turn timer stores an absolute server epoch timestamp (`turnEndsAt`) in match state. However, broadcasting this raw timestamp to clients causes problems when client and server clocks differ. Instead, `buildPayload` computes `turnRemainingMs = turnEndsAt - Date.now()` at the exact moment of broadcast. The client receives this and sets its own local deadline as `Date.now() + turnRemainingMs`, so the countdown is always relative to the client's own clock. The server remains the authority on expiry — it checks `Date.now() >= turnEndsAt` in `matchLoop` and forfeits the turn server-side regardless of what the client shows.

#### 4. Synchronized post-round votes

After a round ends, both players see a popup with "Next Round" and "Exit to Lobby". These buttons send opcodes (`OPCODE_NEXT_ROUND = 4`, `OPCODE_EXIT = 5`) to the server. The server collects votes in `state.nextRoundVotes` and only starts the next round when all human players have voted. Intermediate broadcasts carry the current vote state so each player's popup can show "Waiting for opponent…" or "Opponent wants to continue!" in real time.

#### 5. Bot AI runs entirely on the server

Bot moves are computed inside `matchLoop` immediately after the player's move is applied, in the same server tick. Three difficulty levels:
- **Easy** — random empty cell
- **Medium** — win if possible, block opponent's win, otherwise random
- **Hard** — minimax algorithm (unbeatable)

After a symbol swap between rounds, if the bot now holds `'X'` (goes first), it makes its opening move immediately inside `handleNextRoundVote` before broadcasting the new round state.

#### 6. Quick Match via RPC queue

Quick Match uses a custom RPC (`quick_match`) backed by Nakama storage rather than Nakama's built-in matchmaker. The first player creates a match and writes their entry to a storage queue. The second player reads the queue, finds the waiting match, removes the entry, and joins it. This approach works reliably without requiring matchmaker configuration and supports mode-aware pairing.

#### 7. Leaderboard persistence

Scores are tracked in `state.scores` (in-memory per match) and written to Nakama's leaderboard (`ttt_wins`) only when the series ends (`series_over`) or a player exits (`exited`). The leaderboard is created lazily on first write using `nk.leaderboardCreate` (idempotent). The `incr` operator means each write adds to the player's cumulative score rather than replacing it.

#### 8. Single React component

The entire frontend is one component (`App.tsx`) with screen state managed by `conn` (null = login screen), `joinedMatchId` (null = lobby, set = game board). This keeps the code easy to follow without a router or complex state management library. All server-driven state is updated in a single `onmatchdata` handler.

---

## Features

### Matchmaking
- **⚡ Quick Match** — automatic pairing via RPC queue; first player waits, second joins automatically
- **🔒 Private Match** — create a room and share the Match ID with a specific opponent
- **Join by ID** — paste a Match ID to join a specific room
- **🤖 Play vs Bot** — instant single-player game against server-side AI

### Game Modes
- **Classic** — no turn timer
- **Timed 30s** — 30-second turn timer with server-authoritative expiry and clock-skew correction

### Series System
- Best-of-3 series with round counter in the header
- Symbols swap each round (X↔O) for fairness
- +10 points per round win
- Post-round popup with scores, synchronized Next Round / Exit votes
- Series winner declared after round 3

### Leaderboard
- Global top-20 leaderboard accessible from the lobby
- Scores persisted to Nakama storage at series end
- Current player's row highlighted

### Disconnect Handling
- Player disconnects mid-game → remaining player wins immediately (`opponent_left`)
- Player disconnects during post-round popup → remaining player is sent to lobby (`exited`)

---

## API & Server Configuration

### Nakama Server Endpoints

| Endpoint | URL |
|---|---|
| HTTP API | `http://127.0.0.1:7350` |
| gRPC | `127.0.0.1:7351` |
| Console (admin UI) | `http://127.0.0.1:7351` |

Console credentials: `admin` / `password`

### RPCs

All RPCs require a valid session token in the `Authorization: Bearer <token>` header (handled automatically by the Nakama JS SDK).

| RPC ID | Payload | Response | Description |
|---|---|---|---|
| `create_ttt_match` | `{ mode: "classic"\|"timed" }` | `{ matchId: string }` | Create a new private match room |
| `create_bot_match` | `{ mode: "classic"\|"timed", difficulty: "easy"\|"medium"\|"hard" }` | `{ matchId: string }` | Create a bot match |
| `quick_match` | `{ name: string, mode: "classic"\|"timed" }` | `{ matched: bool, queued: bool, matchId: string }` | Join the quick match queue or get paired with a waiting player |
| `get_leaderboard` | _(empty)_ | `{ records: LeaderboardRecord[] }` | Fetch top-20 global scores |
| `get_quick_match_stats` | _(empty)_ | `{ queueWaiting: number, activePlayers: number, activeMatches: number }` | Queue and match statistics |

### WebSocket Opcodes

Once joined to a match, all real-time communication uses these opcodes:

| Opcode | Constant | Direction | Payload | Description |
|---|---|---|---|---|
| `1` | `OPCODE_STATE` | Server → Client | Full `MatchStatePayload` | Broadcast after every state change |
| `2` | `OPCODE_MOVE` | Client → Server | `{ index: 0–8 }` | Player places a piece |
| `3` | `OPCODE_ERROR` | Server → Client | `{ message: string }` | Validation error (sent only to the offending client) |
| `4` | `OPCODE_NEXT_ROUND` | Client → Server | `{}` | Vote to start the next round |
| `5` | `OPCODE_EXIT` | Client → Server | `{}` | Vote to exit to lobby |

### Match State Payload

Every `OPCODE_STATE` broadcast contains:

| Field | Type | Description |
|---|---|---|
| `board` | `string[9]` | Cell values: `''`, `'X'`, or `'O'` |
| `symbols` | `{ [userId]: 'X'\|'O' }` | Symbol assigned to each player |
| `names` | `{ [userId]: string }` | Display name for each player |
| `turn` | `'X'\|'O'` | Symbol of the player whose turn it is |
| `status` | string | `waiting` · `playing` · `finished` · `exited` · `series_over` |
| `winner` | string \| null | `'X'` · `'O'` · `'draw'` · `'opponent_left'` · `null` |
| `turnEndsAt` | number | Absolute server epoch ms deadline (timed mode) |
| `turnRemainingMs` | number | Ms remaining at broadcast time — use this to avoid clock skew |
| `mode` | `'classic'\|'timed'` | Game mode for this match |
| `round` | number | Current round number (1–3) |
| `scores` | `{ [userId]: number }` | Cumulative points per player |
| `nextRoundVotes` | `{ [userId]: true }` | Which players have voted for next round |
| `bot` | boolean | Whether this is a bot match |
| `botDifficulty` | `'easy'\|'medium'\|'hard'` | Bot difficulty level |

### Frontend Environment Variables

The frontend reads these from `frontend/.env` (or environment at build time):

| Variable | Default | Description |
|---|---|---|
| `VITE_NAKAMA_HOST` | `127.0.0.1` | Nakama server hostname or IP |
| `VITE_NAKAMA_PORT` | `7350` | Nakama HTTP port |
| `VITE_NAKAMA_USE_SSL` | `false` | Set `true` when using HTTPS/WSS |
| `VITE_NAKAMA_SERVER_KEY` | `defaultkey` | Nakama server key (set in Nakama config) |

### Nakama Server Configuration

The server is configured via command-line flags in `docker-compose.yml`:

| Flag | Value | Description |
|---|---|---|
| `--session.token_expiry_sec` | `7200` | Session tokens expire after 2 hours |
| `--logger.level` | `DEBUG` | Log level (change to `INFO` in production) |
| `--runtime.path` | `/nakama/data/modules` | Directory containing `index.js` |

---

## Deployment

### Local development (Docker Compose)

```bash
docker compose up          # foreground, see all logs
docker compose up -d       # background
docker compose logs -f     # follow logs when running in background
docker compose restart nakama   # reload after editing index.js
```

### Production (self-hosted Linux VM)

Tested on Ubuntu 22.04. Works on AWS EC2, GCP Compute Engine, DigitalOcean Droplet, or any VPS.

#### 1. Provision the server

Minimum recommended spec: 1 vCPU, 1 GB RAM, 10 GB disk.

Open these ports in your firewall / security group:

| Port | Protocol | Purpose |
|---|---|---|
| 22 | TCP | SSH |
| 80 | TCP | HTTP (nginx → frontend) |
| 443 | TCP | HTTPS (nginx → frontend) |
| 7350 | TCP | Nakama HTTP API |
| 7351 | TCP | Nakama gRPC / Console |

#### 2. Install Docker on the server

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
# log out and back in
```

#### 3. Deploy the backend

```bash
git clone <repo-url>
cd tic-tac-toe-nakama
docker compose up -d
```

Verify it started:

```bash
docker logs ttt-nakama --tail 20
# Should end with: {"msg":"Startup done"}
```

#### 4. Build and deploy the frontend

On your local machine (or in CI):

```bash
pnpm -C frontend install

# Point the frontend at your server's public IP or domain
VITE_NAKAMA_HOST=<your-server-ip-or-domain> \
VITE_NAKAMA_PORT=7350 \
VITE_NAKAMA_USE_SSL=false \
pnpm -C frontend build
```

This produces a static site in `frontend/dist/`. Serve it with nginx:

```bash
# On the server
sudo apt install nginx -y
sudo cp -r frontend/dist/* /var/www/html/
sudo systemctl restart nginx
```

#### 5. Enable HTTPS (recommended)

```bash
sudo apt install certbot python3-certbot-nginx -y
sudo certbot --nginx -d yourdomain.com
```

Then update your frontend `.env` and rebuild with:

```
VITE_NAKAMA_HOST=yourdomain.com
VITE_NAKAMA_PORT=7350
VITE_NAKAMA_USE_SSL=true
```

> **Note:** Nakama's HTTP API on port 7350 also needs to be behind a TLS-terminating proxy (nginx) for WSS to work. See [Nakama production docs](https://heroiclabs.com/docs/nakama/getting-started/install/docker/) for a full nginx reverse-proxy config.

#### 6. Updating the server module

After editing `nakama/data/modules/index.js`:

```bash
docker compose restart nakama
docker logs ttt-nakama --tail 10   # verify "ttt module loaded"
```

No rebuild required — Nakama reloads the JS file on restart.

---

## Testing Multiplayer

### Manual testing — two browser windows

This is the fastest way to verify the full multiplayer flow.

1. Open **http://localhost:5173** in a normal browser window.
2. Open **http://localhost:5173** in an incognito / private window (ensures a separate session and device ID).
3. Enter different usernames in each window (e.g. `Alice` and `Bob`) and click **Play**.

#### Test: Quick Match

4. Select the same mode (e.g. **Timed 30s**) in both windows.
5. Click **⚡ Quick Match** in window A — it shows "Finding opponent…".
6. Click **⚡ Quick Match** in window B — both windows should enter the game board within 1–2 seconds.
7. Verify both players see each other's names in the scoreboard.

#### Test: Private Match

4. In window A: click **Create Private Match** — a Match ID appears below the button.
5. Copy the Match ID.
6. In window B: paste the Match ID into the input field → click **Join Match**.
7. Both windows should enter the game board.

#### Test: Gameplay

8. Make a move in window A — verify the cell updates in **both** windows immediately.
9. Try clicking a cell in window A when it is window B's turn — the move should be rejected (no change on board).
10. Try clicking an already-occupied cell — should be rejected.

#### Test: Timed mode

11. Start a Timed 30s match.
12. Wait without making a move — after 30 seconds the server should declare the opponent the winner and show the result popup in both windows.
13. Verify the countdown timer appears on the active player's scoreboard card and counts down correctly.

#### Test: Series & voting

14. After a round ends, verify the popup appears in **both** windows.
15. Click **Next Round** in window A — window A should show "Waiting for Bob…" and window B should show "Alice wants to continue!".
16. Click **Next Round** in window B — both windows should close the popup and start round 2 with swapped symbols.
17. After round 3, verify the series result is shown.

#### Test: Exit synchronization

18. After a round ends, click **Exit to Lobby** in window A.
19. Verify **both** windows return to the lobby within 2 seconds.

#### Test: Disconnect handling

20. Start a match, then close window B entirely.
21. Window A should show "You Win! — Opponent disconnected" within a few seconds.

#### Test: Bot match

22. Click **Play vs Bot**, select **Hard** difficulty.
23. The bot should join within ~2 seconds and make moves immediately after yours.
24. After a round, click **Next Round** — only one vote is needed (bot votes automatically).
25. In round 2, the bot should have the opposite symbol and move first if it holds X.

### Checking server logs during testing

```bash
docker logs ttt-nakama -f
```

Useful log lines to watch for:

| Log message | Meaning |
|---|---|
| `New WebSocket session connected` | A player connected |
| `JavaScript runtime function raised an uncaught exception` | A server-side error — check the `error` field |
| `ttt module loaded` | Module reloaded successfully after restart |

### Nakama Console

The Nakama admin console at **http://127.0.0.1:7351** (admin / password) lets you:

- **Runtime → Matches** — see all active matches and their state
- **Storage** — inspect the quick match queue (`quick_match` collection)
- **Leaderboard** — view `ttt_wins` records
- **Accounts** — see registered players and their sessions

---

## Project Structure

```
tic-tac-toe-nakama/
├── docker-compose.yml              # Nakama + PostgreSQL services
├── README.md
├── nakama/
│   └── data/
│       └── modules/
│           └── index.js            # All server-side game logic
└── frontend/
    ├── .env                        # (create this — not committed)
    ├── package.json
    ├── vite.config.ts
    └── src/
        ├── main.tsx                # React entry point
        ├── App.tsx                 # Entire frontend (single component)
        ├── App.css                 # Dark theme styles
        └── nakama.ts               # Nakama client connection helper
```
