# Gilded Poker House (Production Baseline)

Real-time poker ledger with banker/player roles, authoritative server validation, and settlement export.

## New: Poker House Rooms + Multi-Session Balances

- Persistent **Poker House Room** model (room owner + members)
- Multiple sessions inside a room (participants can vary daily)
- Running room balances across sessions (`totalNetCash` per member)
- Room dashboard with:
  - leaderboard/running balances
  - recent sessions
  - active session banner + quick enter
- Banker can create a session from room members + optional guests
- Session finalization now updates room balances/history automatically

## Features Delivered

- Home system
  - Welcome gate: New User (Google + password) / Existing User (email + password)
  - Account session remembered in browser
  - Create game
  - Join game by 6-digit code
  - Share room link
  - Banker dashboard
- Banker
  - Set buy-in value when creating game
  - Approve/reject buy-in and return requests
  - View all player balances
  - View total bank liability
  - Lock/unlock session
  - End session to open cash-out workflow
  - Finalize settlement after cash-out + reconciliation
  - Generate settlement report + CSV export
- Player
  - Join via room code/link
  - View chip balance
  - Request buy-in / return
  - View buy-ins and net result
- Ledger engine
  - Server-side formula: `Total Buy-In - Total Returned = Net Position`
  - Player P/L: `Total Returned - Total Buy-In`
  - Cash-out formula:
    - `totalChipsOutFromPlayer = endingChips + chipsReturned`
    - `netChips = totalChipsOutFromPlayer - chipsIssued`
    - `netCash = netChips * (buyInCash / buyInChips)`
  - Settlement transfer generation (`who owes whom`)
- Cash-out + reconciliation
  - Player self-report and banker entry supported
  - Chip conservation check:
    - `total issued = total returned + total ending chips`
  - Cash reconciliation check:
    - `sum(netCash) = 0` (rounding tolerance)
- Real-time sync
  - Socket.io events for requests, approvals, state updates, and session end freeze
- Security baseline
  - JWT auth + role guards
  - Server-side validation (Zod)
  - Rate limiting
  - Session lock / ended enforcement
  - Duplicate request guard
  - Helmet + CORS
  - Audit logs

## Stack

- Frontend: React + Tailwind + Framer Motion + Socket.io client
- Backend: Node.js + Express + Socket.io + Mongoose
- Database: MongoDB Atlas / local MongoDB
- Deployment: Render (free) or Docker Compose

## Project Structure

- `apps/web` React frontend
- `apps/api` Express + Socket backend
- `docs` architecture and schema docs
- `infra/render.yaml` Render deployment config
- `docker-compose.yml` local full-stack compose

## Local Run (Recommended)

1. Copy env for API:
   ```bash
   cp apps/api/.env.example apps/api/.env
   ```
2. Set `MONGODB_URI`, `JWT_SECRET`, and `GOOGLE_CLIENT_ID` in `apps/api/.env`.
3. Set `VITE_GOOGLE_CLIENT_ID` in `apps/web/.env` (same value as `GOOGLE_CLIENT_ID`).
4. Start API:
   ```bash
   npm run dev -w apps/api
   ```
5. In another terminal start Web:
   ```bash
   npm run dev -w apps/web
   ```
6. Open:
   - Web: `http://localhost:5173`
   - API Health: `http://localhost:4000/api/health`

### Open Banker and Player Separately

- Use one tab/window for banker (create game or banker login).
- For player, open a fresh tab using the shared link that now includes `as=player`, for example:
  - `http://localhost:5173/?room=123456&as=player`
- You can also click **Open Player Tab** from the banker header.
- Auth is tab-scoped, so banker and player can stay logged in at the same time.

### Seed demo session (5 players)

```bash
npm run seed:demo -w apps/api
```

- Demo room code: `777777`
- Demo banker PIN: `1234`

## Docker Run

```bash
docker compose up --build
```

- Web: `http://localhost:8080`
- API: `http://localhost:4000/api/health`
- MongoDB: `mongodb://localhost:27017/gilded-poker`

## Free Hosting (Render)

1. Push repo to GitHub.
2. Create new Render Blueprint using `infra/render.yaml`.
3. Set env vars:
   - `MONGODB_URI` (Mongo Atlas)
   - `JWT_SECRET`
   - `CORS_ORIGIN` (web URL)
   - `GOOGLE_CLIENT_ID`
   - `VITE_API_URL` (public API URL + `/api`)
   - `VITE_GOOGLE_CLIENT_ID`

## API / Socket Contract (High Level)

House APIs (new):
- `POST /api/house/rooms` create poker house room
- `POST /api/house/rooms/:roomCode/join` join room as player
- `POST /api/house/rooms/banker/login` banker room login
- `GET /api/house/rooms/:roomCode/state` room dashboard state
- `POST /api/house/rooms/:roomCode/join-requests/google` join request with Google Sign-In
- `POST /api/house/rooms/member/google-login` existing member Google login
- `POST /api/house/rooms/:roomCode/sessions` create live session inside room (banker)
- `POST /api/house/rooms/:roomCode/sessions/:sessionCode/enter` enter active session (member)
- `GET /api/house/rooms/:roomCode/sessions/:sessionCode` session drill-down

User APIs (new):
- `POST /api/users/signup/google` create/update account via Google and set password
- `POST /api/users/login` existing user login by email + password
- `GET /api/users/me` get current account profile

REST:
- `POST /api/rooms` create game (banker auth token returned)
- `POST /api/rooms/:code/join` player join
- `POST /api/rooms/banker/login` banker re-login by PIN
- `GET /api/rooms/:code/state` role-aware room state
- `GET /api/rooms/:code/settlement.csv` banker CSV export
- Prompt-compatible aliases:
  - `POST /api/auth/login`
  - `POST /api/session/create`
  - `POST /api/session/join`
  - `GET /api/session/:id`
  - `GET /api/session/:id/history`
- `POST /api/session/:id/end`
- `POST /api/session/:id/finalize`
- `POST /api/session/:id/export/csv`

Socket events:
- Client -> Server:
  - `room:subscribe`
  - `player:request` `{ type: BUY_IN|RETURN, amount }`
  - `banker:resolve-request` `{ requestId, action: APPROVE|REJECT, reason }`
  - `banker:lock` `{ locked }`
  - `banker:end-session`
- Prompt-compatible aliases:
  - `request_buyin`
  - `request_return`
  - `approve_request`
  - `reject_request`
  - `admin_adjustment`
  - `cashout_submit`
  - `cashout_set`
  - `cashout_approve`
  - `finalize_settlement`
  - `lock_session`
  - `end_session`
- Server -> Client:
  - `session:state`
  - `session:update`
  - `request:new`
  - `request:resolved`
  - `session:ended`
  - `error:domain`
- Prompt-compatible aliases:
  - `session_state_updated`
  - `request_created`
  - `request_updated`
  - `player_joined`
  - `player_frozen`
  - `cashout_opened`
  - `cashout_submitted`
  - `cashout_updated`
  - `session_locked`
  - `session_ended`
  - `room_state_updated`
  - `balances_updated`
  - `session_started`
