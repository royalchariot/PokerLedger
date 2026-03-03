export function presentRoomForRole(room, role, actorId) {
  const base = {
    code: room.code,
    houseCode: room.houseCode || null,
    sessionName: room.sessionName || "",
    sessionDate: room.sessionDate || null,
    sessionNotes: room.sessionNotes || "",
    status: room.status,
    sessionLocked: room.sessionLocked,
    bankerName: room.banker.name,
    buyInValue: room.settings.buyInValue,
    buyInCash: room.settings.buyInCash,
    buyInChips: room.settings.buyInChips,
    allowReturns: room.settings.allowReturns !== false,
    cashoutMode: room.settings.cashoutMode,
    maxPlayers: room.settings.maxPlayers,
    totals: room.totals,
    endedAt: room.endedAt,
    finalizedAt: room.finalizedAt,
    cashoutOpen: room.cashoutOpen,
    players: room.players.map((p) => ({
      playerId: p.playerId,
      name: p.name,
      seatNo: p.seatNo,
      role: p.role,
      frozen: p.frozen,
      connected: p.connected,
      totalBuyIns: p.totalBuyIns,
      totalReturned: p.totalReturned,
      endingChips: p.endingChips,
      cashoutSubmittedChips: p.cashoutSubmittedChips,
      cashoutSubmittedAt: p.cashoutSubmittedAt,
      cashoutApproved: p.cashoutApproved,
      netPosition: p.netPosition,
      netResult: p.netResult,
      netChips: p.netChips,
      netCash: p.netCash,
    })),
    requests: room.requests,
    transactions: room.transactions || [],
    auditLogs: room.auditLogs || [],
    settlementTransfers: room.settlementTransfers,
  };

  if (role === "BANKER") {
    return base;
  }

  const myPlayer = base.players.find((p) => p.playerId === actorId) || null;
  const myRequests = base.requests.filter((r) => r.playerId === actorId);

  return {
    ...base,
    players: base.players.map((p) => ({
      playerId: p.playerId,
      name: p.name,
      seatNo: p.seatNo,
      role: p.role,
      frozen: p.frozen,
      connected: p.connected,
      totalBuyIns: p.totalBuyIns,
      totalReturned: p.totalReturned,
      netPosition: p.netPosition,
      netResult: p.netResult,
      endingChips: p.endingChips,
      cashoutSubmittedChips: p.cashoutSubmittedChips,
      cashoutSubmittedAt: p.cashoutSubmittedAt,
      cashoutApproved: p.cashoutApproved,
      netChips: p.netChips,
      netCash: p.netCash,
    })),
    requests: myRequests,
    myPlayer,
  };
}
