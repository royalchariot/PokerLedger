import { roomLeaderboard } from "./houseRoom.js";

export function presentHouseForRole(house, role, actorId) {
  const balancesHidden = role !== "BANKER" && !!house?.privacy?.hideBalancesFromPlayers;
  const leaderboard = balancesHidden ? [] : roomLeaderboard(house);
  const joinRequests =
    role === "BANKER"
      ? [...(house.joinRequests || [])]
          .sort((a, b) => new Date(b.requestedAt || 0) - new Date(a.requestedAt || 0))
          .map((r) => ({
            requestId: r.requestId,
            playerName: r.playerName,
            status: r.status,
            reason: r.reason || "",
            requestedAt: r.requestedAt,
            resolvedAt: r.resolvedAt || null,
            resolvedBy: r.resolvedBy || "",
            approvedUserId: r.approvedUserId || "",
          }))
      : [];

  const sessions = [...(house.sessions || [])]
    .sort((a, b) => new Date(b.date || b.createdAt || 0) - new Date(a.date || a.createdAt || 0))
    .map((s) => ({
      sessionCode: s.sessionCode,
      sessionName: s.sessionName,
      date: s.date,
      notes: s.notes || "",
      status: s.status,
      participants: s.participants || [],
      finalResults: s.finalResults || [],
      totals: s.totals || {},
      createdAt: s.createdAt,
      endedAt: s.endedAt,
    }));

  const myBalance = (house.balances || []).find((b) => b.userId === actorId) || null;
  const mySessions = sessions.filter((s) => (s.participants || []).some((p) => p.userId === actorId));

  return {
    roomCode: house.roomCode,
    roomName: house.roomName,
    ownerId: house.ownerId,
    bankerName: house.bankerName,
    activeSessionCode: house.activeSessionCode || null,
    privacy: {
      hideBalancesFromPlayers: !!house?.privacy?.hideBalancesFromPlayers,
      balancesVisibleToAll: !house?.privacy?.hideBalancesFromPlayers,
    },
    members: (house.members || []).map((m) => ({
      userId: m.userId,
      name: m.name,
      role: m.role,
      joinedAt: m.joinedAt,
      sessionsPlayed: Number(m.sessionsPlayed || 0),
      lastPlayedAt: m.lastPlayedAt || null,
    })),
    joinRequests,
    pendingJoinRequests: joinRequests.filter((r) => r.status === "PENDING").length,
    leaderboard,
    sessions,
    myBalance: myBalance
      ? {
          userId: myBalance.userId,
          name: myBalance.name,
          totalNetCash: Number(myBalance.totalNetCash || 0),
          sessionsPlayed: Number(myBalance.sessionsPlayed || 0),
          lastPlayedAt: myBalance.lastPlayedAt || null,
        }
      : null,
    mySessions,
    tooltip: "+ means net won across all sessions, - means net lost across all sessions.",
  };
}
