# Gilded Poker House Architecture

## Stack
- Frontend: React + Tailwind + Framer Motion + Socket.io client
- Backend: Node.js + Express + Socket.io + JWT
- Database: MongoDB Atlas (Mongoose)
- Hosting: Render free tier (API + Static Web)

## Core Modules
- `apps/api/src/routes/rooms.js`
  - Create game, join game, banker login, room state, CSV settlement export.
- `apps/api/src/sockets/handlers.js`
  - Real-time requests, approval/rejection, lock/end session, live state broadcast.
- `apps/api/src/services/ledger.js`
  - Net position and profit/loss formulas.
  - Settlement transfer generation (who owes whom).
- `apps/api/src/models/Room.js`
  - Authoritative room + ledger + audit data.

## Security Controls
- Server-side validation with Zod.
- JWT role-based auth (banker/player).
- Express rate limiting.
- Duplicate request guard (`REQUEST_DEDUP_MS`).
- Session lock + end-state freeze on server side.
- Helmet + CORS configuration.
- Audit log for operational actions.

## Real-time Flow
1. Client authenticates socket with JWT.
2. Player emits `player:request`.
3. Server validates and stores request.
4. Banker receives `request:new` + `session:update`.
5. Banker emits `banker:resolve-request`.
6. Server validates, updates balances, emits `session:update`.
7. At `banker:end-session`, balances freeze and settlement transfers are computed.
