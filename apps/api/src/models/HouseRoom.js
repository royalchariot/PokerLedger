import mongoose from "mongoose";

const HouseMemberSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true },
    name: { type: String, required: true, trim: true, maxlength: 40 },
    role: { type: String, enum: ["OWNER", "ADMIN", "PLAYER"], default: "PLAYER" },
    googleSub: { type: String, default: "" },
    googleEmail: { type: String, default: "", trim: true, lowercase: true },
    joinedAt: { type: Date, default: Date.now },
    sessionsPlayed: { type: Number, default: 0 },
    lastPlayedAt: { type: Date, default: null },
  },
  { _id: false }
);

const HouseBalanceSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true },
    name: { type: String, required: true, trim: true, maxlength: 40 },
    totalNetCash: { type: Number, default: 0 },
    sessionsPlayed: { type: Number, default: 0 },
    lastPlayedAt: { type: Date, default: null },
  },
  { _id: false }
);

const SessionParticipantSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true },
    name: { type: String, required: true, trim: true, maxlength: 40 },
    isGuest: { type: Boolean, default: false },
  },
  { _id: false }
);

const SessionResultSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true },
    name: { type: String, required: true, trim: true, maxlength: 40 },
    isGuest: { type: Boolean, default: false },
    netCash: { type: Number, default: 0 },
    netChips: { type: Number, default: 0 },
    endingChips: { type: Number, default: 0 },
  },
  { _id: false }
);

const JoinRequestSchema = new mongoose.Schema(
  {
    requestId: { type: String, required: true },
    playerName: { type: String, required: true, trim: true, maxlength: 40 },
    googleSub: { type: String, default: "" },
    googleEmail: { type: String, default: "", trim: true, lowercase: true },
    status: { type: String, enum: ["PENDING", "APPROVED", "REJECTED"], default: "PENDING" },
    reason: { type: String, default: "", maxlength: 140 },
    requestedAt: { type: Date, default: Date.now },
    resolvedAt: { type: Date, default: null },
    resolvedBy: { type: String, default: "" },
    approvedUserId: { type: String, default: "" },
  },
  { _id: false }
);

const HouseSessionSchema = new mongoose.Schema(
  {
    sessionCode: { type: String, required: true },
    sessionName: { type: String, required: true, trim: true, maxlength: 80 },
    date: { type: Date, required: true },
    notes: { type: String, default: "", maxlength: 400 },
    status: { type: String, enum: ["ACTIVE", "LOCKED", "CASHOUT", "ENDED"], default: "ACTIVE" },
    participants: { type: [SessionParticipantSchema], default: [] },
    finalResults: { type: [SessionResultSchema], default: [] },
    totals: {
      totalBuyIns: { type: Number, default: 0 },
      totalReturned: { type: Number, default: 0 },
      totalNetCash: { type: Number, default: 0 },
      totalNetChips: { type: Number, default: 0 },
      chipDelta: { type: Number, default: 0 },
      cashDelta: { type: Number, default: 0 },
      tallyMismatch: { type: Boolean, default: false },
    },
    createdAt: { type: Date, default: Date.now },
    endedAt: { type: Date, default: null },
  },
  { _id: false }
);

const HouseRoomSchema = new mongoose.Schema(
  {
    roomCode: { type: String, required: true, unique: true },
    roomName: { type: String, required: true, trim: true, maxlength: 80 },
    ownerId: { type: String, required: true },
    bankerName: { type: String, required: true, trim: true, maxlength: 40 },
    bankerPinHash: { type: String, required: true },
    members: { type: [HouseMemberSchema], default: [] },
    balances: { type: [HouseBalanceSchema], default: [] },
    joinRequests: { type: [JoinRequestSchema], default: [] },
    sessions: { type: [HouseSessionSchema], default: [] },
    activeSessionCode: { type: String, default: null },
    privacy: {
      hideBalancesFromPlayers: { type: Boolean, default: false },
    },
  },
  { timestamps: true }
);

HouseRoomSchema.index({ updatedAt: -1 });

export const HouseRoom = mongoose.model("HouseRoom", HouseRoomSchema);
