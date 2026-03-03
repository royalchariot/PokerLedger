import { Router } from "express";
import bcrypt from "bcryptjs";
import createError from "http-errors";
import { z } from "zod";
import { stringify } from "csv-stringify/sync";

import { Room } from "../models/Room.js";
import { HouseRoom } from "../models/HouseRoom.js";
import { authRequired, requireRole, signAccessToken } from "../middleware/auth.js";
import { validateBody } from "../middleware/validate.js";
import { randomId, generateRoomCode } from "../utils/code.js";
import { env } from "../config/env.js";
import { buildSettlements, recomputeRoomFinancials } from "../services/ledger.js";
import { presentRoomForRole } from "../services/roomPresenter.js";
import { applyEndedSessionToHouse } from "../services/houseRoom.js";

export const roomRouter = Router();

const createRoomSchema = z.object({
  bankerName: z.string().trim().min(2).max(40),
  bankerPin: z.string().trim().regex(/^\d{4,6}$/, "Banker PIN must be 4 to 6 digits"),
  buyInValue: z.number().int().min(1).optional(),
  buyInCash: z.number().positive().optional(),
  buyInChips: z.number().int().min(1).optional(),
  cashoutMode: z.enum(["PLAYER_REPORT", "BANKER_ENTRY", "BOTH"]).optional().default("BOTH"),
  maxPlayers: z.number().int().min(2).max(12),
}).superRefine((data, ctx) => {
  if (!data.buyInCash && !data.buyInValue) {
    ctx.addIssue({ code: "custom", message: "buyInCash or buyInValue is required", path: ["buyInCash"] });
  }
  if (!data.buyInChips && !data.buyInValue) {
    ctx.addIssue({ code: "custom", message: "buyInChips or buyInValue is required", path: ["buyInChips"] });
  }
});

const joinRoomSchema = z.object({
  playerName: z.string().trim().min(2).max(40),
});

const joinSessionBodySchema = z.object({
  code: z.string().regex(/^\d{6}$/),
  playerName: z.string().trim().min(2).max(40),
});

const bankerLoginSchema = z.object({
  code: z.string().regex(/^\d{6}$/),
  bankerPin: z.string().trim().regex(/^\d{4,6}$/),
});

const authLoginSchema = z.object({
  role: z.enum(["BANKER"]),
  code: z.string().regex(/^\d{6}$/),
  pin: z.string().trim().regex(/^\d{4,6}$/),
});

function uniquePlayerName(room, rawName) {
  const base = rawName.trim();
  let name = base;
  let n = 2;
  const exists = (candidate) => room.players.some((p) => p.name.toLowerCase() === candidate.toLowerCase());

  while (exists(name)) {
    name = `${base} ${n}`;
    n += 1;
  }

  return name;
}

async function createSession(req, res, next) {
  try {
    const { bankerName, bankerPin, buyInValue, buyInCash, buyInChips, cashoutMode, maxPlayers } = req.validatedBody;
    const finalBuyInChips = buyInChips || buyInValue;
    const finalBuyInCash = buyInCash || buyInValue;

    let code = generateRoomCode();
    for (let i = 0; i < 12; i += 1) {
      const exists = await Room.findOne({ code }).lean();
      if (!exists) break;
      code = generateRoomCode();
    }

    const bankerId = randomId("banker");
    const pinHash = await bcrypt.hash(bankerPin, 10);
    const expiresAt = new Date(Date.now() + env.roomTtlHours * 60 * 60 * 1000);

    const room = await Room.create({
      code,
      banker: { bankerId, name: bankerName, pinHash },
      settings: {
        buyInValue: buyInValue || finalBuyInChips,
        buyInCash: finalBuyInCash,
        buyInChips: finalBuyInChips,
        cashoutMode,
        maxPlayers,
      },
      players: [],
      requests: [],
      transactions: [],
      totals: {
        totalBuyIns: 0,
        totalReturned: 0,
        totalLiability: 0,
        totalChips: 0,
        totalEndingChips: 0,
        totalNetChips: 0,
        totalNetCash: 0,
        chipDelta: 0,
        cashDelta: 0,
        missingCashoutCount: 0,
        tallyMismatch: false,
      },
      auditLogs: [
        {
          actorRole: "BANKER",
          actorId: bankerId,
          action: "ROOM_CREATED",
          metadata: { bankerName, buyInCash: finalBuyInCash, buyInChips: finalBuyInChips, maxPlayers, cashoutMode },
        },
      ],
      expiresAt,
    });

    const token = signAccessToken({ scope: "SESSION", role: "BANKER", roomCode: room.code, houseCode: room.houseCode || null, actorId: bankerId });

    res.status(201).json({
      token,
      role: "BANKER",
      room: presentRoomForRole(room, "BANKER", bankerId),
    });
  } catch (err) {
    next(err);
  }
}

async function loginBankerByCode(code, bankerPin) {
  const room = await Room.findOne({ code });
  if (!room) throw createError(404, "Room not found");

  const ok = await bcrypt.compare(bankerPin, room.banker.pinHash);
  if (!ok) throw createError(401, "Invalid PIN");

  const token = signAccessToken({
    scope: "SESSION",
    role: "BANKER",
    roomCode: room.code,
    houseCode: room.houseCode || null,
    actorId: room.banker.bankerId,
  });

  return { room, token };
}

async function joinByCode(code, playerName) {
  if (!/^\d{6}$/.test(code)) throw createError(400, "Invalid room code");

  const room = await Room.findOne({ code });
  if (!room) throw createError(404, "Room not found");
  if (room.status === "ENDED") throw createError(409, "Session already ended");
  if (room.sessionLocked) throw createError(423, "Session is locked");
  if (room.players.length >= room.settings.maxPlayers) throw createError(409, "Room is full");

  const finalName = uniquePlayerName(room, playerName);
  const seatNo = room.players.length + 1;
  const playerId = randomId("player");

  room.players.push({
    playerId,
    name: finalName,
    seatNo,
    role: "PLAYER",
    frozen: false,
    connected: false,
    totalBuyIns: 0,
    totalReturned: 0,
    netPosition: 0,
    netResult: 0,
  });

  room.auditLogs.push({
    actorRole: "PLAYER",
    actorId: playerId,
    action: "PLAYER_JOINED",
    metadata: { name: finalName, seatNo },
  });

  await room.save();

  const token = signAccessToken({ scope: "SESSION", role: "PLAYER", roomCode: room.code, houseCode: room.houseCode || null, actorId: playerId });

  return { room, token, playerId };
}

function csvFromRoom(room) {
  const rows = room.players.map((p) => ({
    seatNo: p.seatNo,
    playerName: p.name,
    chipsIssued: p.totalBuyIns,
    chipsReturned: p.totalReturned,
    endingChips: p.endingChips ?? "",
    netChips: p.netChips,
    netCash: Number(p.netCash || 0).toFixed(2),
    netPosition: p.netPosition,
  }));

  return stringify(rows, {
    header: true,
    columns: [
      { key: "seatNo", header: "Seat" },
      { key: "playerName", header: "Player" },
      { key: "chipsIssued", header: "Chips Issued" },
      { key: "chipsReturned", header: "Chips Returned" },
      { key: "endingChips", header: "Ending Chips" },
      { key: "netChips", header: "Net Chips" },
      { key: "netCash", header: "Net Cash" },
      { key: "netPosition", header: "Net Position (BuyIn-(Return+Ending))" },
    ],
  });
}

roomRouter.post("/rooms", validateBody(createRoomSchema), createSession);
roomRouter.post("/session/create", validateBody(createRoomSchema), createSession);

roomRouter.post("/rooms/banker/login", validateBody(bankerLoginSchema), async (req, res, next) => {
  try {
    const { code, bankerPin } = req.validatedBody;
    const { room, token } = await loginBankerByCode(code, bankerPin);
    res.json({ token, role: "BANKER", room: presentRoomForRole(room, "BANKER", room.banker.bankerId) });
  } catch (err) {
    next(err);
  }
});

roomRouter.post("/auth/login", validateBody(authLoginSchema), async (req, res, next) => {
  try {
    const { code, pin } = req.validatedBody;
    const { room, token } = await loginBankerByCode(code, pin);
    res.json({ token, role: "BANKER", room: presentRoomForRole(room, "BANKER", room.banker.bankerId) });
  } catch (err) {
    next(err);
  }
});

roomRouter.post("/rooms/:code/join", validateBody(joinRoomSchema), async (req, res, next) => {
  try {
    const out = await joinByCode(req.params.code, req.validatedBody.playerName);
    res.status(201).json({
      token: out.token,
      role: "PLAYER",
      room: presentRoomForRole(out.room, "PLAYER", out.playerId),
      playerId: out.playerId,
    });
  } catch (err) {
    next(err);
  }
});

roomRouter.post("/session/join", validateBody(joinSessionBodySchema), async (req, res, next) => {
  try {
    const { code, playerName } = req.validatedBody;
    const out = await joinByCode(code, playerName);
    res.status(201).json({
      token: out.token,
      role: "PLAYER",
      room: presentRoomForRole(out.room, "PLAYER", out.playerId),
      playerId: out.playerId,
    });
  } catch (err) {
    next(err);
  }
});

roomRouter.get("/rooms/:code/state", authRequired, async (req, res, next) => {
  try {
    const { code } = req.params;
    const { roomCode, role, actorId } = req.auth;

    if (code !== roomCode) return next(createError(403, "Room mismatch"));

    const room = await Room.findOne({ code });
    if (!room) return next(createError(404, "Room not found"));

    res.json({ room: presentRoomForRole(room, role, actorId) });
  } catch (err) {
    next(err);
  }
});

roomRouter.get("/session/:id", authRequired, async (req, res, next) => {
  try {
    const { id } = req.params;
    if (req.auth.roomCode !== id) return next(createError(403, "Room mismatch"));
    const room = await Room.findOne({ code: id });
    if (!room) return next(createError(404, "Session not found"));
    res.json({ room: presentRoomForRole(room, req.auth.role, req.auth.actorId) });
  } catch (err) {
    next(err);
  }
});

roomRouter.get("/session/:id/history", authRequired, async (req, res, next) => {
  try {
    const { id } = req.params;
    if (req.auth.roomCode !== id) return next(createError(403, "Room mismatch"));
    const room = await Room.findOne({ code: id });
    if (!room) return next(createError(404, "Session not found"));

    res.json({
      sessionId: room.code,
      status: room.status,
      transactionCount: room.transactions.length,
      requestCount: room.requests.length,
      totals: room.totals,
      transactions: room.transactions,
      auditLogs: room.auditLogs,
    });
  } catch (err) {
    next(err);
  }
});

roomRouter.post("/session/:id/end", authRequired, requireRole("BANKER"), async (req, res, next) => {
  try {
    const { id } = req.params;
    if (req.auth.roomCode !== id) return next(createError(403, "Room mismatch"));
    const room = await Room.findOne({ code: id });
    if (!room) return next(createError(404, "Session not found"));

    if (room.status !== "CASHOUT" && room.status !== "ENDED") {
      room.status = "CASHOUT";
      room.sessionLocked = true;
      room.cashoutOpen = true;
      room.endedAt = new Date();
      recomputeRoomFinancials(room);
      room.auditLogs.push({
        actorRole: "BANKER",
        actorId: req.auth.actorId,
        action: "SESSION_CASHOUT_STARTED_API",
      });
      await room.save();

      if (room.houseCode) {
        const house = await HouseRoom.findOne({ roomCode: room.houseCode });
        if (house) {
          const summary = house.sessions.find((s) => s.sessionCode === room.code);
          if (summary) summary.status = "CASHOUT";
          await house.save();
        }
      }
    }

    res.json({ room: presentRoomForRole(room, "BANKER", req.auth.actorId) });
  } catch (err) {
    next(err);
  }
});

roomRouter.post("/session/:id/finalize", authRequired, requireRole("BANKER"), async (req, res, next) => {
  try {
    const { id } = req.params;
    if (req.auth.roomCode !== id) return next(createError(403, "Room mismatch"));
    const room = await Room.findOne({ code: id });
    if (!room) return next(createError(404, "Session not found"));

    if (room.status !== "CASHOUT") return next(createError(409, "Cash-out is not open"));

    recomputeRoomFinancials(room);
    if (room.totals.missingCashoutCount > 0) return next(createError(409, "Missing cash-out entries"));
    if (Math.abs(room.totals.chipDelta) > 0) return next(createError(409, `Chip tally mismatch: ${room.totals.chipDelta}`));
    if (Math.abs(room.totals.cashDelta) > 0) return next(createError(409, `Cash tally mismatch: ${room.totals.cashDelta}`));

    room.status = "ENDED";
    room.cashoutOpen = false;
    room.finalizedAt = new Date();
    room.settlementTransfers = buildSettlements(
      room.players.map((p) => ({
        playerId: p.playerId,
        name: p.name,
        netResult: p.netCash,
      }))
    );
    room.auditLogs.push({
      actorRole: "BANKER",
      actorId: req.auth.actorId,
      action: "SESSION_FINALIZED_API",
      metadata: { finalizedAt: room.finalizedAt },
    });
    await room.save();

    if (room.houseCode) {
      const house = await HouseRoom.findOne({ roomCode: room.houseCode });
      if (house) {
        applyEndedSessionToHouse(house, room);
        await house.save();
      }
    }

    res.json({ room: presentRoomForRole(room, "BANKER", req.auth.actorId) });
  } catch (err) {
    next(err);
  }
});

roomRouter.get("/rooms/:code/settlement.csv", authRequired, requireRole("BANKER"), async (req, res, next) => {
  try {
    const { code } = req.params;
    if (req.auth.roomCode !== code) return next(createError(403, "Room mismatch"));

    const room = await Room.findOne({ code });
    if (!room) return next(createError(404, "Room not found"));

    recomputeRoomFinancials(room);
    const csv = csvFromRoom(room);

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename=settlement-${code}.csv`);
    res.send(csv);
  } catch (err) {
    next(err);
  }
});

roomRouter.post("/session/:id/export/csv", authRequired, requireRole("BANKER"), async (req, res, next) => {
  try {
    const { id } = req.params;
    if (req.auth.roomCode !== id) return next(createError(403, "Room mismatch"));

    const room = await Room.findOne({ code: id });
    if (!room) return next(createError(404, "Session not found"));

    recomputeRoomFinancials(room);
    const csv = csvFromRoom(room);

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename=settlement-${id}.csv`);
    res.send(csv);
  } catch (err) {
    next(err);
  }
});
