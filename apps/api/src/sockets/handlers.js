import createError from "http-errors";

import { Room } from "../models/Room.js";
import { HouseRoom } from "../models/HouseRoom.js";
import { env } from "../config/env.js";
import { randomId } from "../utils/code.js";
import { buildSettlements, recomputeRoomFinancials } from "../services/ledger.js";
import { presentRoomForRole } from "../services/roomPresenter.js";
import { applyEndedSessionToHouse } from "../services/houseRoom.js";
import { presentHouseForRole } from "../services/housePresenter.js";

function now() {
  return new Date();
}

function deny(socket, message) {
  socket.emit("error:domain", { message });
}

function validateRoomActive(room) {
  if (!room) throw createError(404, "Room not found");
  if (room.status === "ENDED") throw createError(409, "Session ended");
}

function validateCashoutOpen(room) {
  if (!room) throw createError(404, "Room not found");
  if (room.status !== "CASHOUT" || !room.cashoutOpen) throw createError(409, "Cash-out is not open");
}

function canModerate(room, auth) {
  if (auth.role === "BANKER") return true;
  if (auth.role !== "PLAYER") return false;
  const p = room.players.find((x) => x.playerId === auth.actorId);
  return !!p && p.role === "CO_BANKER";
}

function emitRoomState(io, room) {
  const payload = {
    room: presentRoomForRole(room, "BANKER", room.banker.bankerId),
    sessionId: room.code,
    roomId: room.houseCode || null,
    timestamp: now().toISOString(),
  };
  io.to(room.code).emit("session:update", payload);
  io.to(room.code).emit("session_state_updated", payload);
}

function emitHouseState(io, house, actorId = "") {
  const payload = {
    roomId: house.roomCode,
    actorId,
    timestamp: now().toISOString(),
    house: presentHouseForRole(house, "BANKER", house.ownerId),
  };
  io.to(`house:${house.roomCode}`).emit("room_state_updated", payload);
  io.to(`house:${house.roomCode}`).emit("balances_updated", payload);
}

function emitRequestCreated(io, room, request, actorId) {
  const payload = {
    sessionId: room.code,
    requestId: request.requestId,
    actorId,
    timestamp: now().toISOString(),
    request,
  };
  io.to(room.code).emit("request:new", payload);
  io.to(room.code).emit("request_created", payload);
}

function emitRequestUpdated(io, room, request, actorId) {
  const payload = {
    sessionId: room.code,
    requestId: request.requestId,
    actorId,
    timestamp: now().toISOString(),
    request,
  };
  io.to(room.code).emit("request:resolved", payload);
  io.to(room.code).emit("request_updated", payload);
}

function antiDup(player) {
  const ts = player.lastRequestAt ? Number(player.lastRequestAt) : 0;
  const cur = Date.now();
  if (cur - ts < env.requestDedupMs) return false;
  player.lastRequestAt = new Date(cur);
  return true;
}

function appendTransaction(room, tx) {
  room.transactions.push({
    transactionId: randomId("tx"),
    requestId: tx.requestId || "",
    playerId: tx.playerId || "",
    playerName: tx.playerName || "",
    type: tx.type,
    amount: Number(tx.amount || 0),
    deltaBuyIns: Number(tx.deltaBuyIns || 0),
    deltaReturned: Number(tx.deltaReturned || 0),
    actorRole: tx.actorRole,
    actorId: tx.actorId,
    reason: tx.reason || "",
    reversed: false,
    reversedByTransactionId: "",
    createdAt: now(),
  });
  return room.transactions[room.transactions.length - 1];
}

function guardRate(socket, key, limit, windowMs) {
  const nowMs = Date.now();
  socket.rateState ||= new Map();
  const item = socket.rateState.get(key) || { count: 0, since: nowMs };
  if (nowMs - item.since > windowMs) {
    socket.rateState.set(key, { count: 1, since: nowMs });
    return true;
  }

  item.count += 1;
  socket.rateState.set(key, item);
  return item.count <= limit;
}

async function createPlayerRequest(io, socket, type, amount) {
  const { roomCode, actorId } = socket.auth;
  const room = await Room.findOne({ code: roomCode });
  validateRoomActive(room);

  if (room.sessionLocked || room.status === "CASHOUT") return deny(socket, "Session is locked");
  if (type === "RETURN" && room?.settings?.allowReturns === false) return deny(socket, "Returns are disabled for this session");

  const player = room.players.find((x) => x.playerId === actorId);
  if (!player) return deny(socket, "Player not found");
  if (player.frozen) return deny(socket, "You are frozen by banker");
  if (!antiDup(player)) return deny(socket, "Duplicate request blocked");

  if (type === "RETURN") {
    const available = player.totalBuyIns - player.totalReturned;
    if (amount > available) return deny(socket, `Return exceeds balance (${available})`);
  }

  const request = {
    requestId: randomId("req"),
    playerId: player.playerId,
    playerName: player.name,
    type,
    amount,
    status: "PENDING",
    createdAt: now(),
  };

  room.requests.push(request);
  room.auditLogs.push({
    actorRole: "PLAYER",
    actorId,
    action: "REQUEST_CREATED",
    metadata: { type, amount, requestId: request.requestId },
  });

  await room.save();
  emitRequestCreated(io, room, request, actorId);
  emitRoomState(io, room);
}

async function resolveRequest(io, socket, payload) {
  const { roomCode, actorId, role } = socket.auth;
  const { requestId, action, reason = "" } = payload || {};

  if (!["APPROVE", "REJECT"].includes(action)) return deny(socket, "Invalid action");

  const room = await Room.findOne({ code: roomCode });
  validateRoomActive(room);
  if (room.status === "CASHOUT") return deny(socket, "Cannot resolve requests in cash-out phase");
  if (!canModerate(room, socket.auth)) return deny(socket, "No permission to moderate requests");

  const request = room.requests.find((r) => r.requestId === requestId);
  if (!request) return deny(socket, "Request not found");
  if (request.status !== "PENDING") return deny(socket, "Request already processed");

  const player = room.players.find((p) => p.playerId === request.playerId);
  if (!player) return deny(socket, "Player not found");

  if (action === "APPROVE") {
    if (request.type === "BUY_IN") {
      player.totalBuyIns += request.amount;
      appendTransaction(room, {
        requestId,
        playerId: player.playerId,
        playerName: player.name,
        type: "BUY_IN_APPROVED",
        amount: request.amount,
        deltaBuyIns: request.amount,
        deltaReturned: 0,
        actorRole: role === "BANKER" ? "BANKER" : "PLAYER",
        actorId,
      });
    } else {
      const available = player.totalBuyIns - player.totalReturned;
      if (request.amount > available) return deny(socket, `Return exceeds balance (${available})`);
      player.totalReturned += request.amount;
      appendTransaction(room, {
        requestId,
        playerId: player.playerId,
        playerName: player.name,
        type: "RETURN_APPROVED",
        amount: request.amount,
        deltaBuyIns: 0,
        deltaReturned: request.amount,
        actorRole: role === "BANKER" ? "BANKER" : "PLAYER",
        actorId,
      });
    }

    request.status = "APPROVED";
  } else {
    request.status = "REJECTED";
    request.reason = reason.slice(0, 140);
  }

  request.resolvedAt = now();
  request.resolvedBy = actorId;

  recomputeRoomFinancials(room);
  room.auditLogs.push({
    actorRole: role === "BANKER" ? "BANKER" : "PLAYER",
    actorId,
    action: "REQUEST_RESOLVED",
    metadata: { requestId, action, reason },
  });

  await room.save();
  emitRequestUpdated(io, room, request, actorId);
  emitRoomState(io, room);
}

async function endSession(io, socket) {
  const { roomCode, actorId, role } = socket.auth;
  const room = await Room.findOne({ code: roomCode });
  validateRoomActive(room);
  if (!canModerate(room, socket.auth)) return deny(socket, "No permission to end session");

  room.status = "CASHOUT";
  room.sessionLocked = true;
  room.cashoutOpen = true;
  room.endedAt = now();

  for (const p of room.players) {
    p.cashoutApproved = false;
    if (p.endingChips == null) p.endingChips = null;
  }

  recomputeRoomFinancials(room);

  room.auditLogs.push({
    actorRole: role === "BANKER" ? "BANKER" : "PLAYER",
    actorId,
    action: "SESSION_CASHOUT_STARTED",
    metadata: { endedAt: room.endedAt },
  });

  await room.save();

  if (room.houseCode) {
    const house = await HouseRoom.findOne({ roomCode: room.houseCode });
    if (house) {
      const summary = house.sessions.find((s) => s.sessionCode === room.code);
      if (summary) summary.status = "CASHOUT";
      await house.save();
      emitHouseState(io, house, actorId);
    }
  }

  io.to(room.code).emit("cashout_opened", {
    sessionId: room.code,
    actorId,
    timestamp: now().toISOString(),
    endedAt: room.endedAt,
  });
  emitRoomState(io, room);
}

async function finalizeSettlement(io, socket) {
  const { roomCode, actorId, role } = socket.auth;
  const room = await Room.findOne({ code: roomCode });
  validateCashoutOpen(room);
  if (!canModerate(room, socket.auth)) return deny(socket, "No permission to finalize settlement");

  recomputeRoomFinancials(room);
  if (room.totals.missingCashoutCount > 0) return deny(socket, "Cash-out missing for some players");
  if (Math.abs(room.totals.chipDelta) > 0) return deny(socket, `Chip tally mismatch: ${room.totals.chipDelta}`);
  if (Math.abs(room.totals.cashDelta) > 0) return deny(socket, `Cash tally mismatch: ${room.totals.cashDelta}`);

  room.status = "ENDED";
  room.cashoutOpen = false;
  room.finalizedAt = now();
  room.settlementTransfers = buildSettlements(
    room.players.map((p) => ({
      playerId: p.playerId,
      name: p.name,
      netResult: p.netCash,
    }))
  );

  room.auditLogs.push({
    actorRole: role === "BANKER" ? "BANKER" : "PLAYER",
    actorId,
    action: "SESSION_ENDED",
    metadata: { finalizedAt: room.finalizedAt },
  });

  await room.save();

  if (room.houseCode) {
    const house = await HouseRoom.findOne({ roomCode: room.houseCode });
    if (house) {
      applyEndedSessionToHouse(house, room);
      await house.save();
      emitHouseState(io, house, actorId);
      io.to(`house:${house.roomCode}`).emit("session_ended", {
        roomId: house.roomCode,
        sessionId: room.code,
        actorId,
        timestamp: now().toISOString(),
        endedAt: room.endedAt,
      });
    }
  }

  io.to(room.code).emit("session:ended", {
    sessionId: room.code,
    actorId,
    timestamp: now().toISOString(),
    endedAt: room.endedAt,
  });
  io.to(room.code).emit("session_ended", {
    sessionId: room.code,
    actorId,
    timestamp: now().toISOString(),
    endedAt: room.endedAt,
  });
  emitRoomState(io, room);
}

async function setLock(io, socket, payload) {
  const { roomCode, actorId, role } = socket.auth;
  const room = await Room.findOne({ code: roomCode });
  validateRoomActive(room);
  if (!canModerate(room, socket.auth)) return deny(socket, "No permission to lock session");

  const locked = !!payload?.locked;
  if (room.status === "CASHOUT" && !locked) return deny(socket, "Cannot unlock during cash-out");
  room.sessionLocked = locked;
  if (room.status !== "CASHOUT") {
    room.status = locked ? "LOCKED" : "OPEN";
  }
  room.auditLogs.push({
    actorRole: role === "BANKER" ? "BANKER" : "PLAYER",
    actorId,
    action: "SESSION_LOCK_TOGGLED",
    metadata: { locked },
  });

  await room.save();
  io.to(room.code).emit("session_locked", {
    sessionId: room.code,
    actorId,
    timestamp: now().toISOString(),
    locked,
  });
  emitRoomState(io, room);
}

export function registerSocketHandlers(io, socket) {
  socket.on("room_join", async () => {
    try {
      const { scope, houseCode, actorId, role } = socket.auth;
      if (scope !== "HOUSE") return deny(socket, "Invalid auth scope for room join");
      const house = await HouseRoom.findOne({ roomCode: houseCode });
      if (!house) return deny(socket, "Room not found");
      socket.join(`house:${house.roomCode}`);
      socket.emit("room_state_updated", {
        roomId: house.roomCode,
        actorId,
        timestamp: now().toISOString(),
        house: presentHouseForRole(house, role === "BANKER" ? "BANKER" : "PLAYER", actorId),
      });
    } catch (err) {
      console.error(err);
      deny(socket, "Failed to join room channel");
    }
  });

  socket.on("room:subscribe", async () => {
    try {
      const { roomCode, role, actorId } = socket.auth;
      if (!roomCode) return deny(socket, "Missing session code");
      const room = await Room.findOne({ code: roomCode });
      if (!room) return deny(socket, "Room not found");

      if (role === "PLAYER") {
        const p = room.players.find((x) => x.playerId === actorId);
        if (!p) return deny(socket, "Player not found in room");
        p.connected = true;
      }

      room.auditLogs.push({
        actorRole: role,
        actorId,
        action: "SOCKET_SUBSCRIBED",
      });

      await room.save();
      socket.join(roomCode);
      if (room.houseCode) socket.join(`house:${room.houseCode}`);

      socket.emit("session:state", {
        room: presentRoomForRole(room, role, actorId),
      });

      io.to(room.code).emit("player_joined", {
        sessionId: room.code,
        actorId,
        timestamp: now().toISOString(),
      });

      emitRoomState(io, room);
    } catch (err) {
      console.error(err);
      deny(socket, "Failed to subscribe room");
    }
  });

  socket.on("player:request", async (payload) => {
    if (!guardRate(socket, "player:request", 6, 10_000)) return deny(socket, "Too many requests");
    try {
      const { role } = socket.auth;
      if (role !== "PLAYER") return deny(socket, "Only players can request");

      const { type, amount } = payload || {};
      if (!["BUY_IN", "RETURN"].includes(type)) return deny(socket, "Invalid request type");
      if (!Number.isInteger(amount) || amount <= 0) return deny(socket, "Amount must be positive integer");

      await createPlayerRequest(io, socket, type, amount);
    } catch (err) {
      if (err.status) return deny(socket, err.message);
      console.error(err);
      deny(socket, "Unable to create request");
    }
  });

  socket.on("request_buyin", async (payload) => {
    if (!guardRate(socket, "request_buyin", 6, 10_000)) return deny(socket, "Too many requests");
    const amount = Number(payload?.amount);
    if (!Number.isInteger(amount) || amount <= 0) return deny(socket, "Amount must be positive integer");
    try {
      await createPlayerRequest(io, socket, "BUY_IN", amount);
    } catch (err) {
      if (err.status) return deny(socket, err.message);
      console.error(err);
      deny(socket, "Unable to create buy-in request");
    }
  });

  socket.on("request_return", async (payload) => {
    if (!guardRate(socket, "request_return", 6, 10_000)) return deny(socket, "Too many requests");
    const amount = Number(payload?.amount);
    if (!Number.isInteger(amount) || amount <= 0) return deny(socket, "Amount must be positive integer");
    try {
      await createPlayerRequest(io, socket, "RETURN", amount);
    } catch (err) {
      if (err.status) return deny(socket, err.message);
      console.error(err);
      deny(socket, "Unable to create return request");
    }
  });

  socket.on("banker:resolve-request", async (payload) => {
    try {
      await resolveRequest(io, socket, payload);
    } catch (err) {
      if (err.status) return deny(socket, err.message);
      console.error(err);
      deny(socket, "Unable to resolve request");
    }
  });

  socket.on("approve_request", async (payload) => {
    try {
      await resolveRequest(io, socket, { ...payload, action: "APPROVE" });
    } catch (err) {
      if (err.status) return deny(socket, err.message);
      console.error(err);
      deny(socket, "Unable to approve request");
    }
  });

  socket.on("reject_request", async (payload) => {
    try {
      await resolveRequest(io, socket, { ...payload, action: "REJECT" });
    } catch (err) {
      if (err.status) return deny(socket, err.message);
      console.error(err);
      deny(socket, "Unable to reject request");
    }
  });

  socket.on("admin_adjustment", async (payload) => {
    try {
      const { roomCode, actorId, role } = socket.auth;
      const room = await Room.findOne({ code: roomCode });
      validateRoomActive(room);
      if (!canModerate(room, socket.auth)) return deny(socket, "No permission for admin adjustment");

      const playerId = String(payload?.playerId || "");
      const deltaBuyIns = Number(payload?.deltaBuyIns || 0);
      const deltaReturned = Number(payload?.deltaReturned || 0);
      const reason = String(payload?.reason || "").slice(0, 140);

      if (!Number.isFinite(deltaBuyIns) || !Number.isFinite(deltaReturned)) return deny(socket, "Invalid adjustment values");
      if (deltaBuyIns === 0 && deltaReturned === 0) return deny(socket, "No adjustment provided");

      const player = room.players.find((p) => p.playerId === playerId);
      if (!player) return deny(socket, "Player not found");

      const nextBuyIns = player.totalBuyIns + deltaBuyIns;
      const nextReturned = player.totalReturned + deltaReturned;
      if (nextBuyIns < 0 || nextReturned < 0) return deny(socket, "Adjustment makes totals negative");
      if (nextReturned > nextBuyIns) return deny(socket, "Returned cannot exceed buy-ins");

      player.totalBuyIns = nextBuyIns;
      player.totalReturned = nextReturned;

      appendTransaction(room, {
        playerId: player.playerId,
        playerName: player.name,
        type: "ADMIN_ADJUSTMENT",
        amount: Math.abs(deltaBuyIns) + Math.abs(deltaReturned),
        deltaBuyIns,
        deltaReturned,
        actorRole: role === "BANKER" ? "BANKER" : "PLAYER",
        actorId,
        reason,
      });

      recomputeRoomFinancials(room);
      room.auditLogs.push({
        actorRole: role === "BANKER" ? "BANKER" : "PLAYER",
        actorId,
        action: "ADMIN_ADJUSTMENT",
        metadata: { playerId, deltaBuyIns, deltaReturned, reason },
      });

      await room.save();
      emitRoomState(io, room);
    } catch (err) {
      if (err.status) return deny(socket, err.message);
      console.error(err);
      deny(socket, "Unable to apply adjustment");
    }
  });

  socket.on("freeze_player", async (payload) => {
    try {
      const { roomCode, actorId, role } = socket.auth;
      const room = await Room.findOne({ code: roomCode });
      validateRoomActive(room);
      if (!canModerate(room, socket.auth)) return deny(socket, "No permission to freeze player");

      const playerId = String(payload?.playerId || "");
      const frozen = !!payload?.frozen;
      const player = room.players.find((p) => p.playerId === playerId);
      if (!player) return deny(socket, "Player not found");

      player.frozen = frozen;
      room.auditLogs.push({
        actorRole: role === "BANKER" ? "BANKER" : "PLAYER",
        actorId,
        action: "PLAYER_FROZEN_TOGGLED",
        metadata: { playerId, frozen },
      });

      await room.save();
      io.to(room.code).emit("player_frozen", {
        sessionId: room.code,
        actorId,
        timestamp: now().toISOString(),
        playerId,
        frozen,
      });
      emitRoomState(io, room);
    } catch (err) {
      if (err.status) return deny(socket, err.message);
      console.error(err);
      deny(socket, "Unable to freeze/unfreeze player");
    }
  });

  socket.on("promote_cobanker", async (payload) => {
    try {
      const { roomCode, actorId } = socket.auth;
      const room = await Room.findOne({ code: roomCode });
      validateRoomActive(room);
      if (socket.auth.role !== "BANKER") return deny(socket, "Only banker can promote co-banker");

      const playerId = String(payload?.playerId || "");
      const enabled = payload?.enabled !== false;
      const player = room.players.find((p) => p.playerId === playerId);
      if (!player) return deny(socket, "Player not found");

      player.role = enabled ? "CO_BANKER" : "PLAYER";
      room.auditLogs.push({
        actorRole: "BANKER",
        actorId,
        action: "CO_BANKER_UPDATED",
        metadata: { playerId, role: player.role },
      });

      await room.save();
      emitRoomState(io, room);
    } catch (err) {
      if (err.status) return deny(socket, err.message);
      console.error(err);
      deny(socket, "Unable to update co-banker role");
    }
  });

  socket.on("undo_last_action", async () => {
    try {
      const { roomCode, actorId, role } = socket.auth;
      const room = await Room.findOne({ code: roomCode });
      validateRoomActive(room);
      if (!canModerate(room, socket.auth)) return deny(socket, "No permission to undo");

      const tx = [...room.transactions]
        .reverse()
        .find((x) => !x.reversed && ["BUY_IN_APPROVED", "RETURN_APPROVED", "ADMIN_ADJUSTMENT"].includes(x.type));
      if (!tx) return deny(socket, "No undoable transaction");

      const ageMs = Date.now() - new Date(tx.createdAt).getTime();
      if (ageMs > 2 * 60 * 1000) return deny(socket, "Undo window expired (2 minutes)");

      const player = room.players.find((p) => p.playerId === tx.playerId);
      if (!player) return deny(socket, "Player missing for undo");

      const nextBuyIns = player.totalBuyIns - tx.deltaBuyIns;
      const nextReturned = player.totalReturned - tx.deltaReturned;
      if (nextBuyIns < 0 || nextReturned < 0 || nextReturned > nextBuyIns) {
        return deny(socket, "Undo not possible due to current ledger state");
      }

      player.totalBuyIns = nextBuyIns;
      player.totalReturned = nextReturned;

      const reversal = appendTransaction(room, {
        playerId: player.playerId,
        playerName: player.name,
        type: "UNDO_REVERSAL",
        amount: tx.amount,
        deltaBuyIns: -tx.deltaBuyIns,
        deltaReturned: -tx.deltaReturned,
        actorRole: role === "BANKER" ? "BANKER" : "PLAYER",
        actorId,
        reason: `Reversal of ${tx.transactionId}`,
      });

      const target = room.transactions.find((x) => x.transactionId === tx.transactionId);
      target.reversed = true;
      target.reversedByTransactionId = reversal.transactionId;

      recomputeRoomFinancials(room);
      room.auditLogs.push({
        actorRole: role === "BANKER" ? "BANKER" : "PLAYER",
        actorId,
        action: "UNDO_LAST_ACTION",
        metadata: { transactionId: tx.transactionId, reversalId: reversal.transactionId },
      });

      await room.save();
      emitRoomState(io, room);
    } catch (err) {
      if (err.status) return deny(socket, err.message);
      console.error(err);
      deny(socket, "Unable to undo transaction");
    }
  });

  socket.on("banker:lock", async (payload) => {
    try {
      await setLock(io, socket, payload);
    } catch (err) {
      if (err.status) return deny(socket, err.message);
      console.error(err);
      deny(socket, "Unable to lock/unlock");
    }
  });

  socket.on("lock_session", async (payload) => {
    try {
      await setLock(io, socket, payload);
    } catch (err) {
      if (err.status) return deny(socket, err.message);
      console.error(err);
      deny(socket, "Unable to lock/unlock");
    }
  });

  socket.on("banker:end-session", async () => {
    try {
      await endSession(io, socket);
    } catch (err) {
      if (err.status) return deny(socket, err.message);
      console.error(err);
      deny(socket, "Unable to end session");
    }
  });

  socket.on("end_session", async () => {
    try {
      await endSession(io, socket);
    } catch (err) {
      if (err.status) return deny(socket, err.message);
      console.error(err);
      deny(socket, "Unable to end session");
    }
  });

  socket.on("cashout_submit", async (payload) => {
    try {
      const { roomCode, actorId, role } = socket.auth;
      if (role !== "PLAYER") return deny(socket, "Only players can submit cash-out");
      const endingChips = Number(payload?.endingChips);
      if (!Number.isInteger(endingChips) || endingChips < 0) return deny(socket, "Invalid ending chips");

      const room = await Room.findOne({ code: roomCode });
      validateCashoutOpen(room);
      const player = room.players.find((p) => p.playerId === actorId);
      if (!player) return deny(socket, "Player not found");

      player.cashoutSubmittedChips = endingChips;
      player.cashoutSubmittedAt = now();
      player.cashoutApproved = false;
      if (room.settings.cashoutMode !== "PLAYER_REPORT") {
        // In BOTH mode allow instant banker override later; keep pending approval false.
      }

      room.auditLogs.push({
        actorRole: "PLAYER",
        actorId,
        action: "CASHOUT_SUBMITTED",
        metadata: { endingChips },
      });

      await room.save();
      io.to(room.code).emit("cashout_submitted", {
        sessionId: room.code,
        actorId,
        playerId: actorId,
        timestamp: now().toISOString(),
        endingChips,
      });
      emitRoomState(io, room);
    } catch (err) {
      if (err.status) return deny(socket, err.message);
      console.error(err);
      deny(socket, "Unable to submit cash-out");
    }
  });

  socket.on("cashout_set", async (payload) => {
    try {
      const { roomCode, actorId, role } = socket.auth;
      const room = await Room.findOne({ code: roomCode });
      validateCashoutOpen(room);
      if (!canModerate(room, socket.auth)) return deny(socket, "No permission to set cash-out");

      const playerId = String(payload?.playerId || "");
      const endingChips = Number(payload?.endingChips);
      if (!Number.isInteger(endingChips) || endingChips < 0) return deny(socket, "Invalid ending chips");

      const player = room.players.find((p) => p.playerId === playerId);
      if (!player) return deny(socket, "Player not found");

      player.endingChips = endingChips;
      player.cashoutApproved = true;

      recomputeRoomFinancials(room);
      room.auditLogs.push({
        actorRole: role === "BANKER" ? "BANKER" : "PLAYER",
        actorId,
        action: "CASHOUT_SET",
        metadata: { playerId, endingChips },
      });

      await room.save();
      io.to(room.code).emit("cashout_updated", {
        sessionId: room.code,
        actorId,
        playerId,
        timestamp: now().toISOString(),
        endingChips,
      });
      emitRoomState(io, room);
    } catch (err) {
      if (err.status) return deny(socket, err.message);
      console.error(err);
      deny(socket, "Unable to set cash-out");
    }
  });

  socket.on("cashout_approve", async (payload) => {
    try {
      const { roomCode, actorId, role } = socket.auth;
      const room = await Room.findOne({ code: roomCode });
      validateCashoutOpen(room);
      if (!canModerate(room, socket.auth)) return deny(socket, "No permission to approve cash-out");

      const playerId = String(payload?.playerId || "");
      const overrideChips = payload?.endingChips;
      const player = room.players.find((p) => p.playerId === playerId);
      if (!player) return deny(socket, "Player not found");

      const source =
        overrideChips != null
          ? Number(overrideChips)
          : player.cashoutSubmittedChips != null
            ? Number(player.cashoutSubmittedChips)
            : null;
      if (source == null || !Number.isInteger(source) || source < 0) return deny(socket, "No valid submitted chips to approve");

      player.endingChips = source;
      player.cashoutApproved = true;

      recomputeRoomFinancials(room);
      room.auditLogs.push({
        actorRole: role === "BANKER" ? "BANKER" : "PLAYER",
        actorId,
        action: "CASHOUT_APPROVED",
        metadata: { playerId, endingChips: source },
      });

      await room.save();
      io.to(room.code).emit("cashout_updated", {
        sessionId: room.code,
        actorId,
        playerId,
        timestamp: now().toISOString(),
        endingChips: source,
      });
      emitRoomState(io, room);
    } catch (err) {
      if (err.status) return deny(socket, err.message);
      console.error(err);
      deny(socket, "Unable to approve cash-out");
    }
  });

  socket.on("finalize_settlement", async () => {
    try {
      await finalizeSettlement(io, socket);
    } catch (err) {
      if (err.status) return deny(socket, err.message);
      console.error(err);
      deny(socket, "Unable to finalize settlement");
    }
  });

  socket.on("session_create", async () => {
    deny(socket, "Use house session create API");
  });

  socket.on("session_start", async () => {
    // session is started when banker enters the created live session
  });

  socket.on("session_end_finalize", async () => {
    try {
      await finalizeSettlement(io, socket);
    } catch (err) {
      if (err.status) return deny(socket, err.message);
      console.error(err);
      deny(socket, "Unable to finalize settlement");
    }
  });

  socket.on("banker:finalize-session", async () => {
    try {
      await finalizeSettlement(io, socket);
    } catch (err) {
      if (err.status) return deny(socket, err.message);
      console.error(err);
      deny(socket, "Unable to finalize settlement");
    }
  });

  socket.on("disconnect", async () => {
    try {
      const { roomCode, role, actorId } = socket.auth;
      if (role !== "PLAYER") return;
      const room = await Room.findOne({ code: roomCode });
      if (!room) return;
      const p = room.players.find((x) => x.playerId === actorId);
      if (!p) return;
      p.connected = false;
      await room.save();
      emitRoomState(io, room);
    } catch (err) {
      console.error(err);
    }
  });
}
