function toCents(value) {
  return Math.round(Number(value || 0) * 100);
}

function fromCents(cents) {
  return Number((Number(cents || 0) / 100).toFixed(2));
}

function normalizeName(name) {
  return String(name || "").trim();
}

export function ensureHouseMember(house, { userId, name, role = "PLAYER" }) {
  const found = house.members.find((m) => m.userId === userId);
  if (found) {
    if (name) found.name = normalizeName(name);
    if (role && role !== "PLAYER") found.role = role;
    return found;
  }

  const next = {
    userId,
    name: normalizeName(name) || "Player",
    role,
    joinedAt: new Date(),
    sessionsPlayed: 0,
    lastPlayedAt: null,
  };
  house.members.push(next);
  return house.members[house.members.length - 1];
}

export function ensureHouseBalance(house, { userId, name }) {
  const found = house.balances.find((b) => b.userId === userId);
  if (found) {
    if (name) found.name = normalizeName(name);
    return found;
  }

  const next = {
    userId,
    name: normalizeName(name) || "Player",
    totalNetCash: 0,
    sessionsPlayed: 0,
    lastPlayedAt: null,
  };
  house.balances.push(next);
  return house.balances[house.balances.length - 1];
}

export function addHouseSessionSummary(house, summary) {
  const existing = house.sessions.find((s) => s.sessionCode === summary.sessionCode);
  if (existing) {
    return existing;
  }

  const sessionSummary = {
    sessionCode: summary.sessionCode,
    sessionName: summary.sessionName,
    date: summary.date || new Date(),
    notes: summary.notes || "",
    status: summary.status || "ACTIVE",
    participants: summary.participants || [],
    finalResults: summary.finalResults || [],
    totals: {
      totalBuyIns: 0,
      totalReturned: 0,
      totalNetCash: 0,
      totalNetChips: 0,
      chipDelta: 0,
      cashDelta: 0,
      tallyMismatch: false,
      ...(summary.totals || {}),
    },
    createdAt: new Date(),
    endedAt: null,
  };
  house.sessions.push(sessionSummary);
  return house.sessions[house.sessions.length - 1];
}

export function applyEndedSessionToHouse(house, sessionRoom) {
  const sessionCode = sessionRoom.code;
  const endedAt = sessionRoom.finalizedAt || sessionRoom.endedAt || new Date();

  const sessionSummary =
    house.sessions.find((s) => s.sessionCode === sessionCode) ||
    addHouseSessionSummary(house, {
      sessionCode,
      sessionName: sessionRoom.sessionName || `Session ${sessionCode}`,
      date: sessionRoom.sessionDate || new Date(),
      notes: sessionRoom.sessionNotes || "",
      status: "ENDED",
      participants: (sessionRoom.players || []).map((p) => ({
        userId: p.playerId,
        name: p.name,
        isGuest: String(p.playerId || "").startsWith("guest_"),
      })),
    });

  const alreadyApplied = sessionSummary.status === "ENDED" && (sessionSummary.finalResults || []).length > 0;
  sessionSummary.status = "ENDED";
  sessionSummary.endedAt = endedAt;
  sessionSummary.totals = {
    totalBuyIns: Number(sessionRoom?.totals?.totalBuyIns || 0),
    totalReturned: Number(sessionRoom?.totals?.totalReturned || 0),
    totalNetCash: Number(sessionRoom?.totals?.totalNetCash || 0),
    totalNetChips: Number(sessionRoom?.totals?.totalNetChips || 0),
    chipDelta: Number(sessionRoom?.totals?.chipDelta || 0),
    cashDelta: Number(sessionRoom?.totals?.cashDelta || 0),
    tallyMismatch: !!sessionRoom?.totals?.tallyMismatch,
  };
  sessionSummary.finalResults = (sessionRoom.players || []).map((p) => ({
    userId: p.playerId,
    name: p.name,
    isGuest: String(p.playerId || "").startsWith("guest_"),
    netCash: Number(p.netCash || 0),
    netChips: Number(p.netChips || 0),
    endingChips: Number(p.endingChips || 0),
  }));

  if (!alreadyApplied) {
    for (const p of sessionRoom.players || []) {
      const isGuest = String(p.playerId || "").startsWith("guest_");
      if (isGuest) continue;

      const member = ensureHouseMember(house, { userId: p.playerId, name: p.name, role: "PLAYER" });
      const balance = ensureHouseBalance(house, { userId: p.playerId, name: p.name });

      const nextCents = toCents(balance.totalNetCash) + toCents(p.netCash);
      balance.totalNetCash = fromCents(nextCents);
      balance.sessionsPlayed = Number(balance.sessionsPlayed || 0) + 1;
      balance.lastPlayedAt = endedAt;

      member.sessionsPlayed = Number(member.sessionsPlayed || 0) + 1;
      member.lastPlayedAt = endedAt;
      if (!member.name) member.name = p.name;
    }
  }

  if (house.activeSessionCode === sessionCode) {
    house.activeSessionCode = null;
  }
}

export function roomLeaderboard(house) {
  return [...(house.balances || [])]
    .sort((a, b) => Number(b.totalNetCash || 0) - Number(a.totalNetCash || 0))
    .map((b) => ({
      userId: b.userId,
      name: b.name,
      totalNetCash: Number(b.totalNetCash || 0),
      sessionsPlayed: Number(b.sessionsPlayed || 0),
      lastPlayedAt: b.lastPlayedAt || null,
    }));
}

