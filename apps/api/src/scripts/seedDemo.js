import bcrypt from "bcryptjs";

import { connectDb } from "../db.js";
import { Room } from "../models/Room.js";
import { recomputeRoomFinancials, buildSettlements } from "../services/ledger.js";

async function seed() {
  await connectDb();

  const code = "777777";
  await Room.deleteOne({ code });

  const pinHash = await bcrypt.hash("1234", 10);

  const room = await Room.create({
    code,
    status: "ENDED",
    banker: {
      bankerId: "banker_demo",
      name: "Rakesh",
      pinHash,
    },
    settings: {
      buyInValue: 500,
      maxPlayers: 8,
    },
    players: [
      { playerId: "p1", name: "Sai", seatNo: 1, totalBuyIns: 1500, totalReturned: 1000, role: "PLAYER", frozen: false },
      { playerId: "p2", name: "Akhil", seatNo: 2, totalBuyIns: 1000, totalReturned: 1500, role: "PLAYER", frozen: false },
      { playerId: "p3", name: "Neha", seatNo: 3, totalBuyIns: 2000, totalReturned: 500, role: "CO_BANKER", frozen: false },
      { playerId: "p4", name: "Raj", seatNo: 4, totalBuyIns: 500, totalReturned: 800, role: "PLAYER", frozen: false },
      { playerId: "p5", name: "Maya", seatNo: 5, totalBuyIns: 1000, totalReturned: 1200, role: "PLAYER", frozen: false },
    ],
    requests: [],
    transactions: [
      {
        transactionId: "tx_demo_1",
        type: "BUY_IN_APPROVED",
        amount: 500,
        deltaBuyIns: 500,
        deltaReturned: 0,
        playerId: "p1",
        playerName: "Sai",
        actorRole: "BANKER",
        actorId: "banker_demo",
      },
    ],
    sessionLocked: true,
    endedAt: new Date(),
    auditLogs: [
      { actorRole: "BANKER", actorId: "banker_demo", action: "ROOM_CREATED", metadata: { demo: true } },
      { actorRole: "BANKER", actorId: "banker_demo", action: "SESSION_ENDED", metadata: { demo: true } },
    ],
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  });

  recomputeRoomFinancials(room);
  room.settlementTransfers = buildSettlements(
    room.players.map((p) => ({
      playerId: p.playerId,
      name: p.name,
      netResult: p.netResult,
    }))
  );

  await room.save();

  console.log("Demo session seeded");
  console.log(`Room code: ${code}`);
  console.log("Banker PIN: 1234");
  process.exit(0);
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
