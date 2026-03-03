import { Router } from "express";
import bcrypt from "bcryptjs";
import createError from "http-errors";
import { z } from "zod";

import { HouseRoom } from "../models/HouseRoom.js";
import { Room } from "../models/Room.js";
import { authRequired, requireRole, signAccessToken } from "../middleware/auth.js";
import { validateBody } from "../middleware/validate.js";
import { generateRoomCode, randomId } from "../utils/code.js";
import { presentHouseForRole } from "../services/housePresenter.js";
import { addHouseSessionSummary, ensureHouseBalance, ensureHouseMember } from "../services/houseRoom.js";
import { presentRoomForRole } from "../services/roomPresenter.js";

export const houseRoomRouter = Router();

const createHouseSchema = z.object({
  roomName: z.string().trim().min(2).max(80),
  bankerName: z.string().trim().min(2).max(40),
  bankerPin: z.string().trim().regex(/^\d{4,6}$/, "Banker PIN must be 4 to 6 digits"),
});

const joinHouseSchema = z.object({
  playerName: z.string().trim().min(2).max(40),
});

const houseBankerLoginSchema = z.object({
  roomCode: z.string().regex(/^\d{6}$/),
  bankerPin: z.string().trim().regex(/^\d{4,6}$/),
});

const rejectJoinRequestSchema = z.object({
  reason: z.string().trim().max(140).optional().default(""),
});

const memberLoginSchema = z
  .object({
    roomCode: z.string().regex(/^\d{6}$/),
    userId: z.string().trim().min(3).optional(),
    playerName: z.string().trim().min(2).max(40).optional(),
  })
  .superRefine((data, ctx) => {
    if (!data.userId && !data.playerName) {
      ctx.addIssue({
        code: "custom",
        message: "userId or playerName is required",
        path: ["userId"],
      });
    }
  });

const createSessionSchema = z.object({
  sessionName: z.string().trim().min(2).max(80).optional(),
  date: z.string().datetime().optional(),
  notes: z.string().max(400).optional(),
  buyInCash: z.number().positive(),
  buyInChips: z.number().int().min(1),
  cashoutMode: z.enum(["PLAYER_REPORT", "BANKER_ENTRY", "BOTH"]).optional().default("BOTH"),
  allowReturns: z.boolean().optional().default(true),
  participantIds: z.array(z.string().min(1)).min(1),
  guestPlayers: z.array(z.string().trim().min(2).max(40)).optional().default([]),
}).superRefine((data, ctx) => {
  const totalParticipants = (data.participantIds?.length || 0) + (data.guestPlayers?.length || 0);
  if (totalParticipants < 2) {
    ctx.addIssue({
      code: "custom",
      message: "At least 2 participants are required to start a session",
      path: ["participantIds"],
    });
  }
});

function roleForHouse(auth) {
  return auth?.role === "BANKER" ? "BANKER" : "PLAYER";
}

function normalizeRoomCode(code) {
  return String(code || "").trim().toUpperCase();
}

function normalizeName(name) {
  return String(name || "").trim().toLowerCase();
}

function uniqueMemberName(house, name) {
  const base = String(name || "").trim();
  let candidate = base;
  let i = 2;
  const exists = (n) => house.members.some((m) => m.name.toLowerCase() === n.toLowerCase());
  while (exists(candidate)) {
    candidate = `${base} ${i}`;
    i += 1;
  }
  return candidate;
}

function emitHouseState(io, house, actorId, role = "BANKER") {
  if (!io) return;
  io.to(`house:${house.roomCode}`).emit("room_state_updated", {
    roomId: house.roomCode,
    actorId,
    timestamp: new Date().toISOString(),
    house: presentHouseForRole(house, role, actorId),
  });
  io.to(`house:${house.roomCode}`).emit("balances_updated", {
    roomId: house.roomCode,
    actorId,
    timestamp: new Date().toISOString(),
    house: presentHouseForRole(house, role, actorId),
  });
}

async function nextUniqueRoomCode() {
  let code = generateRoomCode();
  for (let i = 0; i < 20; i += 1) {
    const exists = await HouseRoom.findOne({ roomCode: code }).lean();
    if (!exists) return code;
    code = generateRoomCode();
  }
  throw createError(500, "Unable to generate unique room code");
}

async function nextUniqueSessionCode() {
  let code = generateRoomCode();
  for (let i = 0; i < 20; i += 1) {
    const exists = await Room.findOne({ code }).lean();
    if (!exists) return code;
    code = generateRoomCode();
  }
  throw createError(500, "Unable to generate unique session code");
}

function assertHouseScope(req) {
  const authHouseCode = req.auth?.houseCode || req.auth?.roomCode;
  const roomCode = normalizeRoomCode(req.params.roomCode);
  if (!authHouseCode || normalizeRoomCode(authHouseCode) !== roomCode) {
    throw createError(403, "Room mismatch");
  }
}

function houseJoinRequestPayload(reqItem) {
  return {
    requestId: reqItem.requestId,
    playerName: reqItem.playerName,
    status: reqItem.status,
    reason: reqItem.reason || "",
    requestedAt: reqItem.requestedAt,
    resolvedAt: reqItem.resolvedAt || null,
    resolvedBy: reqItem.resolvedBy || "",
    approvedUserId: reqItem.approvedUserId || "",
  };
}

houseRoomRouter.post("/house/rooms", validateBody(createHouseSchema), async (req, res, next) => {
  try {
    const { roomName, bankerName, bankerPin } = req.validatedBody;
    const roomCode = await nextUniqueRoomCode();
    const ownerId = randomId("owner");
    const bankerPinHash = await bcrypt.hash(bankerPin, 10);

    const house = await HouseRoom.create({
      roomCode,
      roomName,
      ownerId,
      bankerName,
      bankerPinHash,
      members: [
        {
          userId: ownerId,
          name: bankerName,
          role: "OWNER",
          joinedAt: new Date(),
          sessionsPlayed: 0,
          lastPlayedAt: null,
        },
      ],
      balances: [
        {
          userId: ownerId,
          name: bankerName,
          totalNetCash: 0,
          sessionsPlayed: 0,
          lastPlayedAt: null,
        },
      ],
      sessions: [],
      activeSessionCode: null,
      privacy: {
        hideBalancesFromPlayers: false,
      },
    });

    const token = signAccessToken({
      scope: "HOUSE",
      role: "BANKER",
      houseCode: house.roomCode,
      actorId: ownerId,
    });

    res.status(201).json({
      token,
      role: "BANKER",
      house: presentHouseForRole(house, "BANKER", ownerId),
    });
  } catch (err) {
    next(err);
  }
});

houseRoomRouter.post("/house/rooms/banker/login", validateBody(houseBankerLoginSchema), async (req, res, next) => {
  try {
    const roomCode = normalizeRoomCode(req.validatedBody.roomCode);
    const house = await HouseRoom.findOne({ roomCode });
    if (!house) return next(createError(404, "Room not found"));

    const ok = await bcrypt.compare(req.validatedBody.bankerPin, house.bankerPinHash);
    if (!ok) return next(createError(401, "Invalid PIN"));

    const token = signAccessToken({
      scope: "HOUSE",
      role: "BANKER",
      houseCode: house.roomCode,
      actorId: house.ownerId,
    });

    res.json({
      token,
      role: "BANKER",
      house: presentHouseForRole(house, "BANKER", house.ownerId),
    });
  } catch (err) {
    next(err);
  }
});

houseRoomRouter.post("/house/rooms/member/login", validateBody(memberLoginSchema), async (req, res, next) => {
  try {
    const roomCode = normalizeRoomCode(req.validatedBody.roomCode);
    const house = await HouseRoom.findOne({ roomCode });
    if (!house) return next(createError(404, "Room not found"));

    const inputUserId = String(req.validatedBody.userId || "").trim();
    const inputPlayerName = String(req.validatedBody.playerName || "").trim();

    let member = null;
    if (inputUserId) {
      member = house.members.find((m) => m.userId === inputUserId);
    }
    if (!member && inputPlayerName) {
      const target = normalizeName(inputPlayerName);
      member = house.members.find((m) => normalizeName(m.name) === target);
    }
    if (!member || member.role === "OWNER") {
      return next(createError(404, "Member not found. Ask banker to approve your join request."));
    }

    const token = signAccessToken({
      scope: "HOUSE",
      role: "PLAYER",
      houseCode: house.roomCode,
      actorId: member.userId,
    });

    res.json({
      token,
      role: "PLAYER",
      actorId: member.userId,
      house: presentHouseForRole(house, "PLAYER", member.userId),
    });
  } catch (err) {
    next(err);
  }
});

async function createJoinRequestHandler(req, res, next) {
  try {
    const roomCode = normalizeRoomCode(req.params.roomCode);
    const house = await HouseRoom.findOne({ roomCode });
    if (!house) return next(createError(404, "Room not found"));

    const requestedName = String(req.validatedBody.playerName || "").trim();
    const targetName = normalizeName(requestedName);
    const existingMember = house.members.find((m) => m.role !== "OWNER" && normalizeName(m.name) === targetName);
    if (existingMember) {
      return next(createError(409, "You are already in this room. Use Existing Room to login."));
    }

    const pending = house.joinRequests.find((j) => j.status === "PENDING" && normalizeName(j.playerName) === targetName);
    if (pending) {
      return res.status(202).json({
        roomCode: house.roomCode,
        roomName: house.roomName,
        request: houseJoinRequestPayload(pending),
      });
    }

    const joinReq = {
      requestId: randomId("join"),
      playerName: requestedName,
      status: "PENDING",
      reason: "",
      requestedAt: new Date(),
      resolvedAt: null,
      resolvedBy: "",
      approvedUserId: "",
    };
    house.joinRequests.push(joinReq);
    await house.save();

    const io = req.app.locals.io;
    emitHouseState(io, house, joinReq.requestId, "BANKER");

    res.status(201).json({
      roomCode: house.roomCode,
      roomName: house.roomName,
      request: houseJoinRequestPayload(joinReq),
    });
  } catch (err) {
    next(err);
  }
}

houseRoomRouter.post("/house/rooms/:roomCode/join", validateBody(joinHouseSchema), createJoinRequestHandler);
houseRoomRouter.post("/house/rooms/:roomCode/join-requests", validateBody(joinHouseSchema), createJoinRequestHandler);

houseRoomRouter.get("/house/rooms/:roomCode/join-requests/:requestId", async (req, res, next) => {
  try {
    const roomCode = normalizeRoomCode(req.params.roomCode);
    const requestId = String(req.params.requestId || "").trim();
    const playerName = String(req.query.playerName || "").trim();
    const house = await HouseRoom.findOne({ roomCode });
    if (!house) return next(createError(404, "Room not found"));

    const joinReq = house.joinRequests.find((j) => j.requestId === requestId);
    if (!joinReq) return next(createError(404, "Join request not found"));
    if (playerName && normalizeName(joinReq.playerName) !== normalizeName(playerName)) {
      return next(createError(404, "Join request not found"));
    }

    res.json({
      roomCode: house.roomCode,
      roomName: house.roomName,
      request: houseJoinRequestPayload(joinReq),
      canLogin: joinReq.status === "APPROVED" && !!joinReq.approvedUserId,
    });
  } catch (err) {
    next(err);
  }
});

houseRoomRouter.post(
  "/house/rooms/:roomCode/join-requests/:requestId/approve",
  authRequired,
  requireRole("BANKER"),
  async (req, res, next) => {
    try {
      assertHouseScope(req);

      const roomCode = normalizeRoomCode(req.params.roomCode);
      const requestId = String(req.params.requestId || "").trim();
      const house = await HouseRoom.findOne({ roomCode });
      if (!house) return next(createError(404, "Room not found"));
      if (house.ownerId !== req.auth.actorId) return next(createError(403, "Only room owner can approve join requests"));

      const joinReq = house.joinRequests.find((j) => j.requestId === requestId);
      if (!joinReq) return next(createError(404, "Join request not found"));
      if (joinReq.status !== "PENDING") return next(createError(409, "Join request already resolved"));

      const normalizedRequestedName = normalizeName(joinReq.playerName);
      const existingMember = house.members.find((m) => m.role !== "OWNER" && normalizeName(m.name) === normalizedRequestedName);

      let userId = existingMember?.userId || "";
      let finalName = existingMember?.name || "";
      if (!existingMember) {
        finalName = uniqueMemberName(house, joinReq.playerName);
        userId = randomId("member");
        ensureHouseMember(house, { userId, name: finalName, role: "PLAYER" });
        ensureHouseBalance(house, { userId, name: finalName });
      }

      joinReq.status = "APPROVED";
      joinReq.reason = "";
      joinReq.resolvedAt = new Date();
      joinReq.resolvedBy = req.auth.actorId;
      joinReq.approvedUserId = userId;
      joinReq.playerName = finalName;

      await house.save();

      const io = req.app.locals.io;
      emitHouseState(io, house, req.auth.actorId, "BANKER");

      res.json({
        request: houseJoinRequestPayload(joinReq),
        house: presentHouseForRole(house, "BANKER", req.auth.actorId),
      });
    } catch (err) {
      next(err);
    }
  }
);

houseRoomRouter.post(
  "/house/rooms/:roomCode/join-requests/:requestId/reject",
  authRequired,
  requireRole("BANKER"),
  validateBody(rejectJoinRequestSchema),
  async (req, res, next) => {
    try {
      assertHouseScope(req);

      const roomCode = normalizeRoomCode(req.params.roomCode);
      const requestId = String(req.params.requestId || "").trim();
      const house = await HouseRoom.findOne({ roomCode });
      if (!house) return next(createError(404, "Room not found"));
      if (house.ownerId !== req.auth.actorId) return next(createError(403, "Only room owner can reject join requests"));

      const joinReq = house.joinRequests.find((j) => j.requestId === requestId);
      if (!joinReq) return next(createError(404, "Join request not found"));
      if (joinReq.status !== "PENDING") return next(createError(409, "Join request already resolved"));

      joinReq.status = "REJECTED";
      joinReq.reason = String(req.validatedBody.reason || "").trim();
      joinReq.resolvedAt = new Date();
      joinReq.resolvedBy = req.auth.actorId;
      joinReq.approvedUserId = "";

      await house.save();

      const io = req.app.locals.io;
      emitHouseState(io, house, req.auth.actorId, "BANKER");

      res.json({
        request: houseJoinRequestPayload(joinReq),
        house: presentHouseForRole(house, "BANKER", req.auth.actorId),
      });
    } catch (err) {
      next(err);
    }
  }
);

houseRoomRouter.get("/house/rooms/:roomCode/state", authRequired, async (req, res, next) => {
  try {
    assertHouseScope(req);

    const roomCode = normalizeRoomCode(req.params.roomCode);
    const house = await HouseRoom.findOne({ roomCode });
    if (!house) return next(createError(404, "Room not found"));

    res.json({
      house: presentHouseForRole(house, roleForHouse(req.auth), req.auth.actorId),
    });
  } catch (err) {
    next(err);
  }
});

houseRoomRouter.post(
  "/house/rooms/:roomCode/sessions",
  authRequired,
  requireRole("BANKER"),
  validateBody(createSessionSchema),
  async (req, res, next) => {
    try {
      assertHouseScope(req);

      const roomCode = normalizeRoomCode(req.params.roomCode);
      const house = await HouseRoom.findOne({ roomCode });
      if (!house) return next(createError(404, "Room not found"));
      if (house.ownerId !== req.auth.actorId) return next(createError(403, "Only room owner can create session"));

      if (house.activeSessionCode) {
        const active = await Room.findOne({ code: house.activeSessionCode });
        if (active && active.status !== "ENDED") {
          return next(createError(409, "A live session is already active"));
        }
      }

      const body = req.validatedBody;
      const participantIds = [...new Set(body.participantIds.map(String))];
      const participants = participantIds.map((id) => house.members.find((m) => m.userId === id)).filter(Boolean);
      if (!participants.length) return next(createError(400, "No valid participants selected"));

      const sessionCode = await nextUniqueSessionCode();
      const sessionDate = body.date ? new Date(body.date) : new Date();
      const fallbackName = `Session - ${sessionDate.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      })}`;
      const sessionName = body.sessionName || fallbackName;

      const players = [];
      let seatNo = 1;
      for (const member of participants) {
        players.push({
          playerId: member.userId,
          name: member.name,
          seatNo: seatNo++,
          role: "PLAYER",
          frozen: false,
          connected: false,
          totalBuyIns: 0,
          totalReturned: 0,
          netPosition: 0,
          netResult: 0,
          netChips: 0,
          netCash: 0,
          endingChips: null,
          cashoutSubmittedChips: null,
          cashoutApproved: false,
        });
      }

      const guestParticipants = [];
      for (const guestName of body.guestPlayers || []) {
        const gid = randomId("guest");
        players.push({
          playerId: gid,
          name: guestName,
          seatNo: seatNo++,
          role: "PLAYER",
          frozen: false,
          connected: false,
          totalBuyIns: 0,
          totalReturned: 0,
          netPosition: 0,
          netResult: 0,
          netChips: 0,
          netCash: 0,
          endingChips: null,
          cashoutSubmittedChips: null,
          cashoutApproved: false,
        });
        guestParticipants.push({
          userId: gid,
          name: guestName,
          isGuest: true,
        });
      }

      if (players.length < 2) {
        return next(createError(400, "At least 2 participants are required to start a session"));
      }

      const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      const session = await Room.create({
        code: sessionCode,
        houseCode: house.roomCode,
        sessionName,
        sessionDate,
        sessionNotes: body.notes || "",
        status: "OPEN",
        banker: {
          bankerId: house.ownerId,
          name: house.bankerName,
          pinHash: house.bankerPinHash,
        },
        settings: {
          buyInValue: body.buyInChips,
          buyInCash: body.buyInCash,
          buyInChips: body.buyInChips,
          cashoutMode: body.cashoutMode,
          maxPlayers: players.length,
          allowReturns: body.allowReturns,
        },
        players,
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
          missingCashoutCount: players.length,
          tallyMismatch: true,
        },
        sessionLocked: false,
        cashoutOpen: false,
        settlementTransfers: [],
        auditLogs: [
          {
            actorRole: "BANKER",
            actorId: house.ownerId,
            action: "SESSION_CREATED_FROM_HOUSE",
            metadata: {
              houseCode: house.roomCode,
              sessionName,
              participants: participants.map((m) => m.userId),
              guestCount: guestParticipants.length,
            },
          },
        ],
        expiresAt,
      });

      addHouseSessionSummary(house, {
        sessionCode,
        sessionName,
        date: sessionDate,
        notes: body.notes || "",
        status: "ACTIVE",
        participants: [
          ...participants.map((m) => ({ userId: m.userId, name: m.name, isGuest: false })),
          ...guestParticipants,
        ],
      });
      house.activeSessionCode = sessionCode;
      await house.save();

      const io = req.app.locals.io;
      emitHouseState(io, house, req.auth.actorId, "BANKER");
      if (io) {
        io.to(`house:${house.roomCode}`).emit("session_started", {
          roomId: house.roomCode,
          sessionId: sessionCode,
          actorId: req.auth.actorId,
          timestamp: new Date().toISOString(),
        });
      }

      const sessionToken = signAccessToken({
        scope: "SESSION",
        role: "BANKER",
        roomCode: session.code,
        houseCode: house.roomCode,
        actorId: house.ownerId,
      });

      res.status(201).json({
        sessionCode,
        sessionToken,
        session: presentRoomForRole(session, "BANKER", house.ownerId),
        house: presentHouseForRole(house, "BANKER", house.ownerId),
      });
    } catch (err) {
      next(err);
    }
  }
);

houseRoomRouter.post("/house/rooms/:roomCode/sessions/:sessionCode/enter", authRequired, async (req, res, next) => {
  try {
    assertHouseScope(req);

    const roomCode = normalizeRoomCode(req.params.roomCode);
    const sessionCode = normalizeRoomCode(req.params.sessionCode);
    const house = await HouseRoom.findOne({ roomCode });
    if (!house) return next(createError(404, "Room not found"));

    const session = await Room.findOne({ code: sessionCode, houseCode: roomCode });
    if (!session) return next(createError(404, "Session not found"));

    let role = "PLAYER";
    let actorId = req.auth.actorId;

    if (req.auth.role === "BANKER" && req.auth.actorId === house.ownerId) {
      role = "BANKER";
      actorId = house.ownerId;
    } else {
      const participant = session.players.find((p) => p.playerId === req.auth.actorId);
      if (!participant) return next(createError(403, "You are not a participant in this session"));
    }

    const token = signAccessToken({
      scope: "SESSION",
      role,
      roomCode: session.code,
      houseCode: roomCode,
      actorId,
    });

    res.json({
      token,
      role,
      sessionCode,
      session: presentRoomForRole(session, role, actorId),
      house: presentHouseForRole(house, roleForHouse(req.auth), req.auth.actorId),
    });
  } catch (err) {
    next(err);
  }
});

houseRoomRouter.get("/house/rooms/:roomCode/sessions/:sessionCode", authRequired, async (req, res, next) => {
  try {
    assertHouseScope(req);

    const roomCode = normalizeRoomCode(req.params.roomCode);
    const sessionCode = normalizeRoomCode(req.params.sessionCode);
    const session = await Room.findOne({ code: sessionCode, houseCode: roomCode });
    if (!session) return next(createError(404, "Session not found"));

    res.json({
      session: presentRoomForRole(session, roleForHouse(req.auth), req.auth.actorId),
    });
  } catch (err) {
    next(err);
  }
});
