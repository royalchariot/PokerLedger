import mongoose from "mongoose";

const RequestSchema = new mongoose.Schema(
  {
    requestId: { type: String, required: true },
    playerId: { type: String, required: true },
    playerName: { type: String, required: true },
    type: { type: String, enum: ["BUY_IN", "RETURN"], required: true },
    amount: { type: Number, required: true, min: 1 },
    status: { type: String, enum: ["PENDING", "APPROVED", "REJECTED"], default: "PENDING" },
    reason: { type: String, default: "" },
    createdAt: { type: Date, default: Date.now },
    resolvedAt: { type: Date },
    resolvedBy: { type: String },
  },
  { _id: false }
);

const PlayerSchema = new mongoose.Schema(
  {
    playerId: { type: String, required: true },
    name: { type: String, required: true, trim: true, maxlength: 40 },
    seatNo: { type: Number, required: true },
    role: { type: String, enum: ["PLAYER", "CO_BANKER"], default: "PLAYER" },
    frozen: { type: Boolean, default: false },
    connected: { type: Boolean, default: false },
    totalBuyIns: { type: Number, default: 0, min: 0 },
    totalReturned: { type: Number, default: 0, min: 0 },
    endingChips: { type: Number, default: null },
    cashoutSubmittedChips: { type: Number, default: null },
    cashoutSubmittedAt: { type: Date },
    cashoutApproved: { type: Boolean, default: false },
    netPosition: { type: Number, default: 0 },
    netResult: { type: Number, default: 0 },
    netChips: { type: Number, default: 0 },
    netCash: { type: Number, default: 0 },
    lastRequestAt: { type: Date },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const TransactionSchema = new mongoose.Schema(
  {
    transactionId: { type: String, required: true },
    requestId: { type: String, default: "" },
    playerId: { type: String, default: "" },
    playerName: { type: String, default: "" },
    type: {
      type: String,
      enum: ["BUY_IN_APPROVED", "RETURN_APPROVED", "ADMIN_ADJUSTMENT", "UNDO_REVERSAL"],
      required: true,
    },
    amount: { type: Number, default: 0 },
    deltaBuyIns: { type: Number, default: 0 },
    deltaReturned: { type: Number, default: 0 },
    actorRole: { type: String, enum: ["BANKER", "PLAYER", "SYSTEM"], required: true },
    actorId: { type: String, required: true },
    reason: { type: String, default: "" },
    reversed: { type: Boolean, default: false },
    reversedByTransactionId: { type: String, default: "" },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const AuditSchema = new mongoose.Schema(
  {
    at: { type: Date, default: Date.now },
    actorRole: { type: String, enum: ["BANKER", "PLAYER", "SYSTEM"], required: true },
    actorId: { type: String, default: "" },
    action: { type: String, required: true },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { _id: false }
);

const RoomSchema = new mongoose.Schema(
  {
    code: { type: String, unique: true, required: true },
    houseCode: { type: String, default: null, index: true },
    sessionName: { type: String, default: "" },
    sessionDate: { type: Date, default: Date.now },
    sessionNotes: { type: String, default: "", maxlength: 400 },
    status: { type: String, enum: ["OPEN", "LOCKED", "CASHOUT", "ENDED"], default: "OPEN" },
    banker: {
      bankerId: { type: String, required: true },
      name: { type: String, required: true },
      pinHash: { type: String, required: true },
    },
    settings: {
      buyInValue: { type: Number, required: true, min: 1 },
      buyInCash: { type: Number, default: 20, min: 0.01 },
      buyInChips: { type: Number, default: 500, min: 1 },
      allowReturns: { type: Boolean, default: true },
      cashoutMode: { type: String, enum: ["PLAYER_REPORT", "BANKER_ENTRY", "BOTH"], default: "BOTH" },
      maxPlayers: { type: Number, required: true, min: 2, max: 12 },
    },
    players: { type: [PlayerSchema], default: [] },
    requests: { type: [RequestSchema], default: [] },
    transactions: { type: [TransactionSchema], default: [] },
    totals: {
      totalBuyIns: { type: Number, default: 0 },
      totalReturned: { type: Number, default: 0 },
      totalLiability: { type: Number, default: 0 },
      totalChips: { type: Number, default: 0 },
      totalEndingChips: { type: Number, default: 0 },
      totalNetChips: { type: Number, default: 0 },
      totalNetCash: { type: Number, default: 0 },
      chipDelta: { type: Number, default: 0 },
      cashDelta: { type: Number, default: 0 },
      missingCashoutCount: { type: Number, default: 0 },
      tallyMismatch: { type: Boolean, default: false },
    },
    sessionLocked: { type: Boolean, default: false },
    cashoutOpen: { type: Boolean, default: false },
    finalizedAt: { type: Date },
    endedAt: { type: Date },
    settlementTransfers: {
      type: [
        {
          fromPlayerId: String,
          fromName: String,
          toPlayerId: String,
          toName: String,
          amount: Number,
        },
      ],
      default: [],
    },
    auditLogs: { type: [AuditSchema], default: [] },
    expiresAt: { type: Date, required: true, index: { expires: 0 } },
  },
  { timestamps: true }
);

RoomSchema.index({ "requests.requestId": 1 });
RoomSchema.index({ "transactions.transactionId": 1 });
RoomSchema.index({ code: 1, updatedAt: -1 });
RoomSchema.index({ houseCode: 1, updatedAt: -1 });

export const Room = mongoose.model("Room", RoomSchema);
