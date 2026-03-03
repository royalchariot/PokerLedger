const ZERO_EPSILON = 1e-9;

function toCents(value) {
  return Math.round(Number(value || 0) * 100);
}

function fromCents(cents) {
  const value = Number((Number(cents || 0) / 100).toFixed(2));
  return Math.abs(value) < ZERO_EPSILON ? 0 : value;
}

export function recomputeRoomFinancials(room) {
  const players = room.players || [];
  const buyInCash = Number(room?.settings?.buyInCash || room?.settings?.buyInValue || 1);
  const buyInChips = Number(room?.settings?.buyInChips || room?.settings?.buyInValue || 1);
  const buyInCashCents = toCents(buyInCash);

  let totalBuyIns = 0;
  let totalReturned = 0;
  let totalEndingChips = 0;
  let totalNetChips = 0;
  let totalNetCashCents = 0;
  let missingCashoutCount = 0;
  const playerCashRows = [];

  for (const p of players) {
    p.totalBuyIns = Number(p.totalBuyIns || 0);
    p.totalReturned = Number(p.totalReturned || 0);
    p.endingChips = p.endingChips == null ? null : Number(p.endingChips || 0);

    const ending = p.endingChips == null ? 0 : p.endingChips;
    const totalChipsOutFromPlayer = ending + p.totalReturned;

    p.netChips = totalChipsOutFromPlayer - p.totalBuyIns;
    const netCashCents = buyInChips > 0 ? Math.round((p.netChips * buyInCashCents) / buyInChips) : 0;
    playerCashRows.push({ player: p, netCashCents });
    totalNetCashCents += netCashCents;

    // Formula requested: Total Buy-in - Total Returned = Net Position (house liability per player).
    p.netPosition = p.totalBuyIns - totalChipsOutFromPlayer;

    totalBuyIns += p.totalBuyIns;
    totalReturned += p.totalReturned;
    totalEndingChips += ending;
    totalNetChips += p.netChips;
    if (p.endingChips == null) missingCashoutCount += 1;
  }

  const chipDelta = totalBuyIns - (totalReturned + totalEndingChips);
  // Keep cent-level bookkeeping balanced when chips are perfectly conserved.
  if (missingCashoutCount === 0 && chipDelta === 0 && totalNetCashCents !== 0 && playerCashRows.length) {
    const target =
      playerCashRows
        .filter((x) => x.player.netChips !== 0)
        .sort((a, b) => Math.abs(b.player.netChips) - Math.abs(a.player.netChips))[0] || playerCashRows[0];
    target.netCashCents -= totalNetCashCents;
    totalNetCashCents = 0;
  }

  for (const row of playerCashRows) {
    row.player.netCash = fromCents(row.netCashCents);
    // Keep backward compatible fields.
    row.player.netResult = row.player.netCash;
  }

  room.totals.totalBuyIns = totalBuyIns;
  room.totals.totalReturned = totalReturned;
  room.totals.totalLiability = totalBuyIns - totalReturned;
  room.totals.totalChips = totalBuyIns;
  room.totals.totalEndingChips = totalEndingChips;
  room.totals.totalNetChips = totalNetChips;
  room.totals.totalNetCash = fromCents(totalNetCashCents);
  room.totals.chipDelta = chipDelta;
  room.totals.cashDelta = fromCents(totalNetCashCents);
  room.totals.missingCashoutCount = missingCashoutCount;
  room.totals.tallyMismatch =
    missingCashoutCount > 0 ||
    Math.abs(room.totals.chipDelta) > 0 ||
    Math.abs(room.totals.cashDelta) > 0;
}

export function buildSettlements(players) {
  const winners = [];
  const losers = [];

  for (const p of players) {
    const netResultCents = toCents(p.netResult);
    if (netResultCents > 0) winners.push({ playerId: p.playerId, name: p.name, amountCents: netResultCents });
    if (netResultCents < 0) losers.push({ playerId: p.playerId, name: p.name, amountCents: Math.abs(netResultCents) });
  }

  const transfers = [];
  let i = 0;
  let j = 0;

  while (i < losers.length && j < winners.length) {
    const l = losers[i];
    const w = winners[j];
    const amountCents = Math.min(l.amountCents, w.amountCents);

    transfers.push({
      fromPlayerId: l.playerId,
      fromName: l.name,
      toPlayerId: w.playerId,
      toName: w.name,
      amount: fromCents(amountCents),
    });

    l.amountCents -= amountCents;
    w.amountCents -= amountCents;

    if (l.amountCents === 0) i += 1;
    if (w.amountCents === 0) j += 1;
  }

  return transfers;
}
