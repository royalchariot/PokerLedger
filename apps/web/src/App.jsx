import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { jwtDecode } from "jwt-decode";

import { api, withAuth } from "./lib/api";
import { connectSocket } from "./lib/socket";
import {
  clearAuth,
  clearHouseAuth,
  clearUserAuth,
  loadAuth,
  loadHouseAuth,
  loadUserAuth,
  saveAuth,
  saveHouseAuth,
  saveUserAuth,
} from "./lib/storage";

const MEMBER_HINTS_KEY = "gilded-house-member-hints-v1";
const GOOGLE_SCRIPT_ID = "google-identity-services-script";

function loadGoogleIdentityScript() {
  if (typeof window === "undefined") return Promise.reject(new Error("window is not available"));
  if (window.google?.accounts?.id) return Promise.resolve(window.google);

  const existing = document.getElementById(GOOGLE_SCRIPT_ID);
  if (existing) {
    return new Promise((resolve, reject) => {
      const startedAt = Date.now();
      const tick = () => {
        if (window.google?.accounts?.id) {
          resolve(window.google);
          return;
        }
        if (Date.now() - startedAt > 5000) {
          reject(new Error("Google script did not initialize"));
          return;
        }
        window.setTimeout(tick, 60);
      };
      tick();
    });
  }

  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.id = GOOGLE_SCRIPT_ID;
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.defer = true;
    script.onload = () => resolve(window.google);
    script.onerror = () => reject(new Error("Failed to load Google script"));
    document.head.appendChild(script);
  });
}

function toMoney(n) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(
    Number(n || 0)
  );
}

function toCash(n) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number(n || 0));
}

function parseAuth(token) {
  const decoded = jwtDecode(token);
  return {
    token,
    scope: decoded.scope || (decoded.roomCode ? "SESSION" : "HOUSE"),
    role: decoded.role,
    roomCode: decoded.roomCode || null,
    houseCode: decoded.houseCode || decoded.roomCode || null,
    actorId: decoded.actorId,
  };
}

function parseUserAuth(token) {
  const decoded = jwtDecode(token);
  return {
    token,
    scope: decoded.scope || "USER",
    userId: decoded.actorId || "",
    email: decoded.email || "",
    name: decoded.name || "",
    exp: Number(decoded.exp || 0),
  };
}

function userTokenExpired(userAuth) {
  const exp = Number(userAuth?.exp || 0);
  if (!exp) return false;
  return Date.now() >= exp * 1000;
}

function readBootParams() {
  const params = new URLSearchParams(window.location.search);
  const room = String(params.get("room") || "").trim().toUpperCase();
  const as = String(params.get("as") || "").trim().toLowerCase();
  return {
    room,
    asPlayer: as === "player",
  };
}

function statusBadge(status) {
  if (status === "ENDED") return "bg-red-500/20 text-red-200 border-red-500/40";
  if (status === "CASHOUT") return "bg-cyan-500/20 text-cyan-200 border-cyan-500/40";
  if (status === "LOCKED") return "bg-orange-500/20 text-orange-200 border-orange-500/40";
  return "bg-emerald-500/20 text-emerald-200 border-emerald-500/40";
}

function loadMemberHints() {
  try {
    const raw = localStorage.getItem(MEMBER_HINTS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function rememberMemberHint(roomCode, userId, playerName) {
  if (!roomCode || !userId || !playerName) return;
  const hints = loadMemberHints();
  hints[String(roomCode).toUpperCase()] = {
    userId: String(userId),
    playerName: String(playerName),
    savedAt: new Date().toISOString(),
  };
  try {
    localStorage.setItem(MEMBER_HINTS_KEY, JSON.stringify(hints));
  } catch {
    // ignore storage failures
  }
}

export default function App() {
  const boot = useMemo(() => readBootParams(), []);
  const [userAuth, setUserAuth] = useState(() => loadUserAuth());
  const [accountMode, setAccountMode] = useState("WELCOME");
  const [houseAuth, setHouseAuth] = useState(() => {
    if (boot.asPlayer) {
      clearHouseAuth();
      return null;
    }
    return loadHouseAuth();
  });
  const [house, setHouse] = useState(null);
  const [houseConnected, setHouseConnected] = useState(false);
  const [auth, setAuth] = useState(() => {
    if (boot.asPlayer) {
      clearAuth();
      return null;
    }
    return loadAuth();
  });
  const [room, setRoom] = useState(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState("");
  const [pendingAlert, setPendingAlert] = useState("");
  const [isConnected, setIsConnected] = useState(false);
  const [soundOn, setSoundOn] = useState(false);
  const [entryMode, setEntryMode] = useState("CHOICE");
  const googleClientId = String(import.meta.env.VITE_GOOGLE_CLIENT_ID || "").trim();
  const [googleReady, setGoogleReady] = useState(false);
  const [signupPassword, setSignupPassword] = useState("");
  const [existingAccountForm, setExistingAccountForm] = useState({
    email: "",
    password: "",
  });

  const [houseCreateForm, setHouseCreateForm] = useState({
    roomName: "",
    bankerName: "",
    bankerPin: "",
  });
  const [houseJoinRequestForm, setHouseJoinRequestForm] = useState({
    roomCode: boot.room || "",
    playerName: "",
  });
  const [joinRequestTicket, setJoinRequestTicket] = useState(null);
  const [houseBankerLoginForm, setHouseBankerLoginForm] = useState({
    roomCode: "",
    bankerPin: "",
  });
  const [houseExistingPlayerForm, setHouseExistingPlayerForm] = useState({
    roomCode: boot.room || "",
    playerName: "",
    userId: "",
  });
  const [existingRoomRole, setExistingRoomRole] = useState("PLAYER");
  const [joinRejectReason, setJoinRejectReason] = useState({});
  const [houseSessionForm, setHouseSessionForm] = useState({
    sessionName: "",
    notes: "",
    buyInCash: 20,
    buyInChips: 500,
    cashoutMode: "BOTH",
    allowReturns: true,
    participantIds: [],
    guestPlayers: "",
  });

  const [requestForm, setRequestForm] = useState({
    buyInAmount: 500,
    returnAmount: 500,
  });

  const [rejectReason, setRejectReason] = useState({});
  const [adjustment, setAdjustment] = useState({
    playerId: "",
    deltaBuyIns: 0,
    deltaReturned: 0,
    reason: "",
  });
  const [cashoutInputByPlayer, setCashoutInputByPlayer] = useState({});
  const [myCashoutInput, setMyCashoutInput] = useState(0);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(""), 2200);
    return () => clearTimeout(id);
  }, [toast]);

  useEffect(() => {
    if (userAuth) {
      saveUserAuth(userAuth);
      return;
    }
    clearUserAuth();
  }, [userAuth]);

  useEffect(() => {
    if (!userAuth) return;
    if (!userTokenExpired(userAuth)) return;
    clearUserAuth();
    setUserAuth(null);
    setToast("Account session expired. Please login again.");
  }, [userAuth]);

  useEffect(() => {
    if (userAuth) return;
    clearAuth();
    clearHouseAuth();
    setAuth(null);
    setRoom(null);
    setHouseAuth(null);
    setHouse(null);
    setIsConnected(false);
    setHouseConnected(false);
  }, [userAuth]);

  useEffect(() => {
    if (!googleClientId) {
      setGoogleReady(false);
      return undefined;
    }
    let active = true;
    loadGoogleIdentityScript()
      .then(() => {
        if (active) setGoogleReady(true);
      })
      .catch(() => {
        if (active) setGoogleReady(false);
      });
    return () => {
      active = false;
    };
  }, [googleClientId]);

  useEffect(() => {
    if (auth) saveAuth(auth);
  }, [auth]);

  useEffect(() => {
    if (houseAuth) saveHouseAuth(houseAuth);
  }, [houseAuth]);

  useEffect(() => {
    if (!house?.members?.length) return;
    setHouseSessionForm((s) => {
      if (s.participantIds.length) return s;
      return { ...s, participantIds: house.members.map((m) => m.userId) };
    });
  }, [house?.roomCode, house?.members]);

  useEffect(() => {
    if (!boot.room || auth || houseAuth) return;
    setEntryMode("JOIN");
    setHouseJoinRequestForm((s) => ({ ...s, roomCode: boot.room }));
    setHouseExistingPlayerForm((s) => ({ ...s, roomCode: boot.room }));
  }, [boot.room, auth, houseAuth]);

  useEffect(() => {
    if (!auth) return;
    if (auth.scope === "SESSION") return;
    clearAuth();
    setAuth(null);
    setRoom(null);
    setToast("Session token was invalid for dashboard. Please continue from room dashboard.");
  }, [auth]);

  useEffect(() => {
    const code = String(houseExistingPlayerForm.roomCode || "").trim().toUpperCase();
    if (!code) return;
    const hints = loadMemberHints();
    const hint = hints[code];
    if (!hint) return;
    setHouseExistingPlayerForm((s) => {
      if (String(s.userId || "").trim()) return s;
      return {
        ...s,
        userId: hint.userId || "",
        playerName: hint.playerName || s.playerName,
      };
    });
  }, [houseExistingPlayerForm.roomCode]);

  const myPlayer = useMemo(() => {
    if (!room || auth?.role !== "PLAYER") return null;
    if (room.myPlayer) return room.myPlayer;
    const actorId = auth?.actorId;
    if (!actorId) return null;
    return room.players?.find((p) => p.playerId === actorId) || null;
  }, [room, auth?.actorId, auth?.role]);

  const myHouseBalance = useMemo(() => {
    if (!house) return null;
    if (house.myBalance && (!houseAuth?.actorId || house.myBalance.userId === houseAuth.actorId)) {
      return house.myBalance;
    }
    if (houseAuth?.actorId) {
      return (house.leaderboard || []).find((b) => b.userId === houseAuth.actorId) || null;
    }
    return house.myBalance || null;
  }, [house, houseAuth?.actorId]);

  useEffect(() => {
    if (!userAuth) return;
    const fallback = String(userAuth.email || "").split("@")[0];
    const displayName = String(userAuth.name || fallback || "").trim();
    if (!displayName) return;
    setHouseCreateForm((s) => ({ ...s, bankerName: s.bankerName || displayName }));
    setHouseJoinRequestForm((s) => ({ ...s, playerName: s.playerName || displayName }));
    setHouseExistingPlayerForm((s) => ({ ...s, playerName: s.playerName || displayName }));
  }, [userAuth?.userId, userAuth?.name, userAuth?.email]);

  async function signupWithGoogle(credential) {
    const password = String(signupPassword || "");
    if (password.length < 6) {
      setToast("Set a password with at least 6 characters before Google signup.");
      return;
    }
    try {
      setBusy(true);
      const res = await api.post("/users/signup/google", {
        credential,
        password,
      });
      const nextUser = parseUserAuth(res.data.token);
      setUserAuth(nextUser);
      setExistingAccountForm((s) => ({
        ...s,
        email: res.data.user?.email || s.email,
        password: "",
      }));
      setAccountMode("WELCOME");
      setSignupPassword("");
      setToast(`Welcome ${res.data.user?.name || "Player"}`);
    } catch (err) {
      setToast(err?.response?.data?.message || "Unable to create account with Google");
    } finally {
      setBusy(false);
    }
  }

  async function loginExistingAccount(e) {
    e.preventDefault();
    try {
      setBusy(true);
      const res = await api.post("/users/login", {
        email: String(existingAccountForm.email || "").trim(),
        password: existingAccountForm.password,
      });
      const nextUser = parseUserAuth(res.data.token);
      setUserAuth(nextUser);
      setExistingAccountForm((s) => ({ ...s, password: "" }));
      setAccountMode("WELCOME");
      setToast(`Welcome back ${res.data.user?.name || "Player"}`);
    } catch (err) {
      setToast(err?.response?.data?.message || "Unable to login");
    } finally {
      setBusy(false);
    }
  }

  function logoutAccount() {
    clearUserAuth();
    setUserAuth(null);
    clearAuth();
    clearHouseAuth();
    setAuth(null);
    setRoom(null);
    setHouseAuth(null);
    setHouse(null);
    setIsConnected(false);
    setHouseConnected(false);
    setEntryMode("CHOICE");
    setAccountMode("WELCOME");
    setToast("Account logged out");
  }

  async function createHouse(e) {
    e.preventDefault();
    try {
      setBusy(true);
      clearAuth();
      setAuth(null);
      setRoom(null);
      const res = await api.post("/house/rooms", {
        roomName: houseCreateForm.roomName,
        bankerName: houseCreateForm.bankerName,
        bankerPin: houseCreateForm.bankerPin,
      });
      const nextAuth = parseAuth(res.data.token);
      setHouseAuth(nextAuth);
      setHouse(res.data.house);
      setHouseSessionForm((s) => ({
        ...s,
        participantIds: (res.data.house?.members || []).map((m) => m.userId),
      }));
      setToast(`Room ${res.data.house.roomCode} created`);
      setEntryMode("CHOICE");
    } catch (err) {
      setToast(err?.response?.data?.message || "Unable to create room");
    } finally {
      setBusy(false);
    }
  }

  async function sendJoinRequest(e) {
    e.preventDefault();
    try {
      setBusy(true);
      const code = String(houseJoinRequestForm.roomCode || "").trim();
      const res = await api.post(`/house/rooms/${code}/join-requests`, {
        playerName: houseJoinRequestForm.playerName,
      });
      setJoinRequestTicket({
        roomCode: res.data.roomCode,
        roomName: res.data.roomName,
        playerName: houseJoinRequestForm.playerName,
        request: res.data.request,
      });
      setToast("Join request sent to banker");
    } catch (err) {
      setToast(err?.response?.data?.message || "Unable to send join request");
    } finally {
      setBusy(false);
    }
  }

  async function checkJoinRequestStatus() {
    if (!joinRequestTicket?.roomCode || !joinRequestTicket?.request?.requestId) return;
    try {
      setBusy(true);
      const res = await api.get(
        `/house/rooms/${joinRequestTicket.roomCode}/join-requests/${joinRequestTicket.request.requestId}`,
        {
          params: {
            playerName: joinRequestTicket.playerName,
          },
        }
      );
      const nextTicket = {
        ...joinRequestTicket,
        request: res.data.request,
      };
      setJoinRequestTicket(nextTicket);

      if (res.data.canLogin && res.data.request?.approvedUserId) {
        clearAuth();
        setAuth(null);
        setRoom(null);
        const loginRes = await api.post("/house/rooms/member/login", {
          roomCode: joinRequestTicket.roomCode,
          userId: res.data.request.approvedUserId,
        });
        const nextAuth = parseAuth(loginRes.data.token);
        setHouseAuth(nextAuth);
        setHouse(loginRes.data.house);
        const memberName = loginRes.data.house?.myBalance?.name || joinRequestTicket.playerName;
        rememberMemberHint(loginRes.data.house.roomCode, loginRes.data.actorId, memberName);
        setEntryMode("CHOICE");
        setToast(`Welcome to ${loginRes.data.house.roomName}`);
        return;
      }

      if (res.data.request?.status === "REJECTED") {
        setToast(res.data.request.reason || "Join request rejected");
        return;
      }

      setToast("Still pending banker approval");
    } catch (err) {
      setToast(err?.response?.data?.message || "Unable to check join request status");
    } finally {
      setBusy(false);
    }
  }

  async function loginHouseBanker(e) {
    e.preventDefault();
    try {
      setBusy(true);
      clearAuth();
      setAuth(null);
      setRoom(null);
      const res = await api.post("/house/rooms/banker/login", {
        roomCode: String(houseBankerLoginForm.roomCode || "").trim(),
        bankerPin: houseBankerLoginForm.bankerPin,
      });
      const nextAuth = parseAuth(res.data.token);
      setHouseAuth(nextAuth);
      setHouse(res.data.house);
      setToast(`Connected to room ${res.data.house.roomCode}`);
      setEntryMode("CHOICE");
    } catch (err) {
      setToast(err?.response?.data?.message || "Unable to login as room banker");
    } finally {
      setBusy(false);
    }
  }

  async function loginExistingMember(e) {
    e.preventDefault();
    try {
      setBusy(true);
      clearAuth();
      setAuth(null);
      setRoom(null);
      const roomCode = String(houseExistingPlayerForm.roomCode || "").trim();
      const userId = String(houseExistingPlayerForm.userId || "").trim();
      const playerName = String(houseExistingPlayerForm.playerName || "").trim();
      const payload = {
        roomCode,
        ...(userId ? { userId } : {}),
        ...(!userId && playerName ? { playerName } : {}),
      };

      const res = await api.post("/house/rooms/member/login", payload);
      const nextAuth = parseAuth(res.data.token);
      setHouseAuth(nextAuth);
      setHouse(res.data.house);
      rememberMemberHint(res.data.house.roomCode, res.data.actorId, res.data.house.myBalance?.name || playerName);
      setEntryMode("CHOICE");
      setToast(`Welcome back to ${res.data.house.roomName}`);
    } catch (err) {
      setToast(err?.response?.data?.message || "Unable to login to existing room");
    } finally {
      setBusy(false);
    }
  }

  function logoutSession() {
    clearAuth();
    setAuth(null);
    setRoom(null);
    setIsConnected(false);
    setToast(houseAuth ? "Left active session" : "Logged out");
  }

  function backToRoomLeaderboard() {
    logoutSession();
    if (houseAuth?.token) {
      fetchHouseState(houseAuth.token).catch(() => {});
    }
  }

  function logoutHouse() {
    clearHouseAuth();
    setHouseAuth(null);
    setHouse(null);
    setHouseConnected(false);
    setHouseSessionForm((s) => ({ ...s, participantIds: [] }));
    if (!auth) {
      setToast("Room logged out");
    }
  }

  async function copyShareLink() {
    const code = room?.houseCode || room?.code;
    if (!code) return;
    const link = `${window.location.origin}?room=${code}&as=player`;
    await navigator.clipboard.writeText(link);
    setToast("Share link copied");
  }

  function shareWhatsApp() {
    const code = room?.houseCode || room?.code;
    if (!code) return;
    const link = `${window.location.origin}?room=${code}&as=player`;
    const text = encodeURIComponent(`Join poker ledger room ${code}: ${link}`);
    window.open(`https://wa.me/?text=${text}`, "_blank");
  }

  function openPlayerTab() {
    const code = room?.houseCode || room?.code;
    if (!code) return;
    const link = `${window.location.origin}?room=${code}&as=player`;
    window.open(link, "_blank", "noopener,noreferrer");
  }

  function toggleParticipant(userId) {
    setHouseSessionForm((s) => {
      const has = s.participantIds.includes(userId);
      if (has) {
        return { ...s, participantIds: s.participantIds.filter((x) => x !== userId) };
      }
      return { ...s, participantIds: [...s.participantIds, userId] };
    });
  }

  function emit(event, payload = {}) {
    const socket = window.__gildedSocket;
    if (!socket?.connected) {
      setToast("Socket disconnected. Reconnecting...");
      return;
    }
    socket.emit(event, payload);
  }

  async function fetchHouseState(tokenOverride) {
    const token = tokenOverride || houseAuth?.token;
    const roomCode = houseAuth?.houseCode;
    if (!token || !roomCode) return;
    const res = await api.get(`/house/rooms/${roomCode}/state`, withAuth(token));
    setHouse(res.data.house);
  }

  async function createSessionInRoom() {
    if (!house?.roomCode || !houseAuth?.token) return;
    try {
      setBusy(true);
      const guestPlayers = String(houseSessionForm.guestPlayers || "")
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean);

      const totalParticipants = houseSessionForm.participantIds.length + guestPlayers.length;
      if (totalParticipants < 2) {
        setToast("Select at least 2 participants (members + guests)");
        setBusy(false);
        return;
      }

      const res = await api.post(
        `/house/rooms/${house.roomCode}/sessions`,
        {
          sessionName: houseSessionForm.sessionName || undefined,
          notes: houseSessionForm.notes || "",
          buyInCash: Number(houseSessionForm.buyInCash),
          buyInChips: Number(houseSessionForm.buyInChips),
          cashoutMode: houseSessionForm.cashoutMode,
          allowReturns: !!houseSessionForm.allowReturns,
          participantIds: houseSessionForm.participantIds,
          guestPlayers,
        },
        withAuth(houseAuth.token)
      );

      setAuth(parseAuth(res.data.sessionToken));
      setRoom(res.data.session);
      if (res.data.house) setHouse(res.data.house);
      setToast(`Session ${res.data.sessionCode} started`);
    } catch (err) {
      setToast(err?.response?.data?.message || "Unable to create session");
    } finally {
      setBusy(false);
    }
  }

  async function approveJoinRequest(requestId) {
    if (!house?.roomCode || !houseAuth?.token || !requestId) return;
    try {
      setBusy(true);
      const res = await api.post(
        `/house/rooms/${house.roomCode}/join-requests/${requestId}/approve`,
        {},
        withAuth(houseAuth.token)
      );
      if (res.data.house) setHouse(res.data.house);
      setToast("Join request approved");
    } catch (err) {
      setToast(err?.response?.data?.message || "Unable to approve join request");
    } finally {
      setBusy(false);
    }
  }

  async function rejectJoinRequest(requestId) {
    if (!house?.roomCode || !houseAuth?.token || !requestId) return;
    try {
      setBusy(true);
      const reason = String(joinRejectReason[requestId] || "").trim();
      const res = await api.post(
        `/house/rooms/${house.roomCode}/join-requests/${requestId}/reject`,
        { reason },
        withAuth(houseAuth.token)
      );
      if (res.data.house) setHouse(res.data.house);
      setJoinRejectReason((s) => ({ ...s, [requestId]: "" }));
      setToast("Join request rejected");
    } catch (err) {
      setToast(err?.response?.data?.message || "Unable to reject join request");
    } finally {
      setBusy(false);
    }
  }

  async function enterActiveSession() {
    if (!house?.activeSessionCode || !house?.roomCode || !houseAuth?.token) return;
    try {
      setBusy(true);
      const res = await api.post(
        `/house/rooms/${house.roomCode}/sessions/${house.activeSessionCode}/enter`,
        {},
        withAuth(houseAuth.token)
      );
      setAuth(parseAuth(res.data.token));
      setRoom(res.data.session);
      if (res.data.house) setHouse(res.data.house);
      setToast(`Entered live session ${house.activeSessionCode}`);
    } catch (err) {
      setToast(err?.response?.data?.message || "Unable to enter active session");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    let active = true;
    if (!houseAuth?.token || !houseAuth?.houseCode) return undefined;

    async function initHouse() {
      try {
        const res = await api.get(`/house/rooms/${houseAuth.houseCode}/state`, withAuth(houseAuth.token));
        if (active) setHouse(res.data.house);
      } catch (err) {
        if (active) setToast(err?.response?.data?.message || "Failed to load room state");
      }

      const socket = connectSocket(houseAuth.token);
      window.__gildedHouseSocket = socket;

      socket.on("connect", () => {
        if (!active) return;
        setHouseConnected(true);
        socket.emit("room_join");
      });
      socket.on("disconnect", () => {
        if (!active) return;
        setHouseConnected(false);
      });
      socket.on("room_state_updated", (payload) => {
        if (!active) return;
        if (payload?.house) setHouse(payload.house);
      });
      socket.on("balances_updated", (payload) => {
        if (!active) return;
        if (payload?.house) setHouse(payload.house);
      });
      socket.on("session_started", () => {
        if (!active) return;
        fetchHouseState(houseAuth.token).catch(() => {});
        setToast("Live session started");
      });
      socket.on("session_ended", () => {
        if (!active) return;
        fetchHouseState(houseAuth.token).catch(() => {});
        setToast("Session ended and balances updated");
      });
      socket.on("error:domain", ({ message }) => {
        if (!active) return;
        if (message) setToast(message);
      });
    }

    initHouse();

    return () => {
      active = false;
      if (window.__gildedHouseSocket) {
        window.__gildedHouseSocket.disconnect();
        window.__gildedHouseSocket = null;
      }
    };
  }, [houseAuth?.token, houseAuth?.houseCode]);

  useEffect(() => {
    if (auth?.token) return;
    if (!houseAuth?.token) return;
    fetchHouseState().catch(() => {});
  }, [auth?.token, houseAuth?.token]);

  useEffect(() => {
    let active = true;

    async function init() {
      if (!auth?.token || !auth?.roomCode) return;
      try {
        const res = await api.get(`/rooms/${auth.roomCode}/state`, withAuth(auth.token));
        if (active) setRoom(res.data.room);
      } catch (err) {
        if (!active) return;
        const status = err?.response?.status;
        const message = err?.response?.data?.message || "Failed to load room state";
        if (status === 401 || status === 403 || status === 404) {
          clearAuth();
          setAuth(null);
          setRoom(null);
          setIsConnected(false);
          setToast("Session dashboard token expired/invalid. Returned to room dashboard.");
          if (houseAuth?.token) fetchHouseState(houseAuth.token).catch(() => {});
          return;
        }
        setToast(message);
      }

      const socket = connectSocketProxy(auth?.token, setRoom, setToast, auth?.role, setPendingAlert, setIsConnected, soundOn);
      window.__gildedSocket = socket;
    }

    init();

    return () => {
      active = false;
      if (window.__gildedSocket) {
        window.__gildedSocket.disconnect();
        window.__gildedSocket = null;
      }
    };
  }, [auth?.token, auth?.role, auth?.roomCode, houseAuth?.token, soundOn]);

  async function requestBuyIn() {
    if (!requestForm.buyInAmount) return;
    emit("request_buyin", { amount: Number(requestForm.buyInAmount) });
  }

  async function requestReturn() {
    if (!requestForm.returnAmount) return;
    emit("request_return", { amount: Number(requestForm.returnAmount) });
  }

  function resolveRequest(requestId, action) {
    if (action === "APPROVE") {
      emit("approve_request", { requestId });
      return;
    }
    emit("reject_request", { requestId, reason: rejectReason[requestId] || "" });
  }

  function toggleLock() {
    emit("lock_session", { locked: !room.sessionLocked });
  }

  function endSession() {
    emit("end_session", {});
  }

  function finalizeSettlement() {
    emit("finalize_settlement", {});
  }

  function submitMyCashout() {
    emit("cashout_submit", { endingChips: Number(myCashoutInput || 0) });
  }

  function setCashoutForPlayer(playerId) {
    const endingChips = Number(cashoutInputByPlayer[playerId] || 0);
    emit("cashout_set", { playerId, endingChips });
  }

  function approveCashout(playerId) {
    const val = cashoutInputByPlayer[playerId];
    if (val != null && String(val) !== "") {
      emit("cashout_approve", { playerId, endingChips: Number(val) });
      return;
    }
    emit("cashout_approve", { playerId });
  }

  function freezePlayer(playerId, frozen) {
    emit("freeze_player", { playerId, frozen });
  }

  function promoteCoBanker(playerId, enabled) {
    emit("promote_cobanker", { playerId, enabled });
  }

  function undoLastAction() {
    emit("undo_last_action", {});
  }

  function applyAdjustment() {
    if (!adjustment.playerId) return setToast("Select a player for adjustment");
    emit("admin_adjustment", {
      playerId: adjustment.playerId,
      deltaBuyIns: Number(adjustment.deltaBuyIns || 0),
      deltaReturned: Number(adjustment.deltaReturned || 0),
      reason: adjustment.reason || "",
    });
    setAdjustment((s) => ({ ...s, deltaBuyIns: 0, deltaReturned: 0, reason: "" }));
  }

  async function exportCsv() {
    if (!room?.code || !auth?.token) return;
    const res = await api.get(`/rooms/${room.code}/settlement.csv`, {
      ...withAuth(auth.token),
      responseType: "blob",
    });
    const url = URL.createObjectURL(res.data);
    const a = document.createElement("a");
    a.href = url;
    a.download = `settlement-${room.code}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const pendingRequests = useMemo(() => {
    if (!room?.requests) return [];
    return room.requests.filter((r) => r.status === "PENDING");
  }, [room?.requests]);
  const googleEnabled = !!googleClientId;
  const googleButtonReady = googleEnabled && googleReady;

  if (!userAuth) {
    return (
      <div className="app-shell min-h-screen text-gold-100">
        <div className="mx-auto max-w-4xl px-4 py-10">
          <header className="mb-8">
            <BrandLockup
              centered
              title="Welcome to Poker House"
              subtitle="Sign in first. Then you can create a room, join a room, or open an existing room."
            />
          </header>

          {accountMode === "WELCOME" ? (
            <div className="grid gap-4 md:grid-cols-2">
              <button className="card interactive-tile text-left transition hover:border-gold-300/50" onClick={() => setAccountMode("NEW")}>
                <h2 className="font-cinzel text-2xl">New User</h2>
                <p className="mt-2 text-sm text-gold-100/70">Sign up with Google and set a password once.</p>
              </button>
              <button className="card interactive-tile text-left transition hover:border-gold-300/50" onClick={() => setAccountMode("EXISTING")}>
                <h2 className="font-cinzel text-2xl">Existing User</h2>
                <p className="mt-2 text-sm text-gold-100/70">Login using your email and password.</p>
              </button>
            </div>
          ) : null}

          {accountMode === "NEW" ? (
            <div className="card mx-auto max-w-xl space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="font-cinzel text-xl">New User Sign Up</h2>
                <button className="btn-ghost text-sm" type="button" onClick={() => setAccountMode("WELCOME")}>
                  Back
                </button>
              </div>
              <input
                className="input"
                type="password"
                placeholder="Set password (min 6 chars)"
                value={signupPassword}
                onChange={(e) => setSignupPassword(e.target.value)}
              />
              {googleButtonReady ? (
                <GoogleSignInButton
                  clientId={googleClientId}
                  disabled={busy}
                  helperText="Google verifies your identity. Password is used for existing-user login."
                  onCredential={signupWithGoogle}
                  onFailure={(message) => setToast(message || "Google Sign-In failed")}
                />
              ) : googleEnabled ? (
                <div className="text-xs text-gold-100/60">Loading Google Sign-In...</div>
              ) : (
                <div className="text-xs text-gold-100/60">Google Sign-In disabled. Set `VITE_GOOGLE_CLIENT_ID`.</div>
              )}
            </div>
          ) : null}

          {accountMode === "EXISTING" ? (
            <form onSubmit={loginExistingAccount} className="card mx-auto max-w-xl space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="font-cinzel text-xl">Existing User Login</h2>
                <button className="btn-ghost text-sm" type="button" onClick={() => setAccountMode("WELCOME")}>
                  Back
                </button>
              </div>
              <input
                className="input"
                type="email"
                placeholder="Email"
                value={existingAccountForm.email}
                onChange={(e) => setExistingAccountForm((s) => ({ ...s, email: e.target.value }))}
              />
              <input
                className="input"
                type="password"
                placeholder="Password"
                value={existingAccountForm.password}
                onChange={(e) => setExistingAccountForm((s) => ({ ...s, password: e.target.value }))}
              />
              <button disabled={busy} className="btn-gold w-full" type="submit">
                {busy ? "Logging in..." : "Login"}
              </button>
            </form>
          ) : null}
        </div>
        <Toast message={toast} />
      </div>
    );
  }

  if (!auth && houseAuth && house) {
    return (
      <div className="app-shell min-h-screen text-gold-100">
        <div className="mx-auto max-w-7xl px-4 py-6">
          <header className="header-glass mb-4 rounded-2xl border border-gold-500/20 p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <BrandLockup
                title="Welcome to Poker House"
                subtitle={`${house.roomName} • Code ${house.roomCode} • + means net won, - means net lost`}
              />
              <div className="flex flex-wrap gap-2">
                <span className="rounded-full border border-gold-500/30 bg-black/30 px-3 py-1 text-xs text-gold-100/80">{userAuth.email}</span>
                <span
                  className={`live-pill rounded-full border px-3 py-1 text-xs ${
                    houseConnected ? "border-emerald-500/40 bg-emerald-500/20 text-emerald-100" : "border-red-500/40 bg-red-500/20 text-red-100"
                  }`}
                >
                  {houseConnected ? "Room Live" : "Reconnecting"}
                </span>
                <button className="btn-ghost text-sm" onClick={() => fetchHouseState().catch(() => {})}>
                  Refresh
                </button>
                <button className="btn-ghost text-sm" onClick={logoutHouse}>
                  Logout Room
                </button>
                <button className="btn-ghost text-sm" onClick={logoutAccount}>
                  Logout Account
                </button>
              </div>
            </div>
          </header>

          {house.activeSessionCode ? (
            <div className="mb-4 rounded-xl border border-cyan-500/40 bg-cyan-500/10 p-3 text-cyan-100">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="font-semibold">LIVE SESSION RUNNING — {house.activeSessionCode}</div>
                <button className="btn-gold text-sm" onClick={enterActiveSession} disabled={busy}>
                  {busy ? "Opening..." : "Join / View"}
                </button>
              </div>
            </div>
          ) : null}

          <div className="mb-4 grid gap-3 sm:grid-cols-4">
            <Metric label="Members" value={house.members?.length || 0} />
            <Metric label="Sessions" value={house.sessions?.length || 0} />
            <Metric label="My Balance" value={toCash(myHouseBalance?.totalNetCash || 0)} />
            <Metric label="Active Session" value={house.activeSessionCode || "None"} />
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            <div className="card lg:col-span-2">
              <h2 className="mb-3 font-cinzel text-xl">Leaderboard / Running Balances</h2>
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead className="text-gold-100/70">
                    <tr>
                      <th className="px-2 py-2 text-left">Member</th>
                      <th className="px-2 py-2 text-right">Balance</th>
                      <th className="px-2 py-2 text-right">Sessions</th>
                      <th className="px-2 py-2 text-right">Last Played</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(house.leaderboard || []).map((m) => (
                      <tr key={m.userId} className="border-t border-gold-500/10">
                        <td className="px-2 py-2">{m.name}</td>
                        <td className={`px-2 py-2 text-right ${m.totalNetCash >= 0 ? "text-emerald-300" : "text-red-300"}`}>
                          {toCash(m.totalNetCash)}
                        </td>
                        <td className="px-2 py-2 text-right">{m.sessionsPlayed || 0}</td>
                        <td className="px-2 py-2 text-right text-gold-100/70">
                          {m.lastPlayedAt ? new Date(m.lastPlayedAt).toLocaleDateString() : "-"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="card">
              <h2 className="mb-3 font-cinzel text-xl">Recent Sessions</h2>
              <div className="max-h-80 space-y-2 overflow-auto text-sm">
                {(house.sessions || []).length ? (
                  house.sessions.map((s) => (
                    <div key={s.sessionCode} className="rounded-lg border border-gold-500/20 p-2">
                      <div className="font-semibold">{s.sessionName}</div>
                      <div className="text-xs text-gold-100/70">
                        {new Date(s.date || s.createdAt).toLocaleString()} • {s.status}
                      </div>
                      <div className="text-xs text-gold-100/70">Participants: {(s.participants || []).length}</div>
                    </div>
                  ))
                ) : (
                  <div className="text-gold-100/60">No sessions yet</div>
                )}
              </div>
            </div>
          </div>

          {houseAuth.role === "BANKER" ? (
            <>
              <div className="card mt-4">
                <h2 className="mb-3 font-cinzel text-xl">Pending Join Requests</h2>
                {(house.joinRequests || []).filter((r) => r.status === "PENDING").length ? (
                  <div className="space-y-2">
                    {(house.joinRequests || [])
                      .filter((r) => r.status === "PENDING")
                      .map((r) => (
                        <div key={r.requestId} className="rounded-lg border border-gold-500/20 bg-black/20 p-3">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div>
                              <div className="font-semibold">{r.playerName}</div>
                              <div className="text-xs text-gold-100/70">{new Date(r.requestedAt).toLocaleString()}</div>
                            </div>
                            <div className="flex gap-2">
                              <button className="btn-gold text-sm" onClick={() => approveJoinRequest(r.requestId)} disabled={busy}>
                                Approve
                              </button>
                              <button className="btn-ghost text-sm" onClick={() => rejectJoinRequest(r.requestId)} disabled={busy}>
                                Reject
                              </button>
                            </div>
                          </div>
                          <input
                            className="input mt-2"
                            placeholder="Reject reason (optional)"
                            value={joinRejectReason[r.requestId] || ""}
                            onChange={(e) =>
                              setJoinRejectReason((s) => ({
                                ...s,
                                [r.requestId]: e.target.value,
                              }))
                            }
                          />
                        </div>
                      ))}
                  </div>
                ) : (
                  <div className="text-sm text-gold-100/70">No pending join requests.</div>
                )}
              </div>

              <div className="card mt-4">
                <h2 className="mb-3 font-cinzel text-xl">Create Session</h2>
                <div className="grid gap-3 md:grid-cols-3">
                  <input
                    className="input"
                    placeholder="Session name (optional)"
                    value={houseSessionForm.sessionName}
                    onChange={(e) => setHouseSessionForm((s) => ({ ...s, sessionName: e.target.value }))}
                  />
                  <input
                    className="input"
                    type="number"
                    min={1}
                    value={houseSessionForm.buyInCash}
                    onChange={(e) => setHouseSessionForm((s) => ({ ...s, buyInCash: e.target.value }))}
                  />
                  <input
                    className="input"
                    type="number"
                    min={1}
                    value={houseSessionForm.buyInChips}
                    onChange={(e) => setHouseSessionForm((s) => ({ ...s, buyInChips: e.target.value }))}
                  />
                </div>
                <textarea
                  className="input mt-2 w-full"
                  placeholder="Session notes"
                  value={houseSessionForm.notes}
                  onChange={(e) => setHouseSessionForm((s) => ({ ...s, notes: e.target.value }))}
                />
                <div className="mt-2 grid gap-3 md:grid-cols-2">
                  <select
                    className="input"
                    value={houseSessionForm.cashoutMode}
                    onChange={(e) => setHouseSessionForm((s) => ({ ...s, cashoutMode: e.target.value }))}
                  >
                    <option value="BOTH">Cash-out: Both modes</option>
                    <option value="PLAYER_REPORT">Cash-out: Player self-report</option>
                    <option value="BANKER_ENTRY">Cash-out: Banker entry only</option>
                  </select>
                  <input
                    className="input"
                    placeholder="Guest players (comma separated)"
                    value={houseSessionForm.guestPlayers}
                    onChange={(e) => setHouseSessionForm((s) => ({ ...s, guestPlayers: e.target.value }))}
                  />
                </div>
                <label className="mt-2 flex items-center gap-2 text-sm text-gold-100/80">
                  <input
                    type="checkbox"
                    checked={!!houseSessionForm.allowReturns}
                    onChange={(e) => setHouseSessionForm((s) => ({ ...s, allowReturns: e.target.checked }))}
                  />
                  Allow returns
                </label>
                <div className="mt-3">
                  <div className="mb-2 text-sm text-gold-100/70">Select participants</div>
                  <div className="grid gap-2 sm:grid-cols-3">
                    {(house.members || []).map((m) => (
                      <label key={m.userId} className="flex items-center gap-2 rounded-lg border border-gold-500/20 bg-black/20 p-2 text-sm">
                        <input
                          type="checkbox"
                          checked={houseSessionForm.participantIds.includes(m.userId)}
                          onChange={() => toggleParticipant(m.userId)}
                        />
                        <span>{m.name}</span>
                      </label>
                    ))}
                  </div>
                </div>
                <div className="mt-3 flex gap-2">
                  <button className="btn-gold" onClick={createSessionInRoom} disabled={busy || !!house.activeSessionCode}>
                    {busy ? "Starting..." : "Start Session"}
                  </button>
                  {house.activeSessionCode ? (
                    <button className="btn-ghost" onClick={enterActiveSession}>
                      Open Active Session
                    </button>
                  ) : null}
                </div>
              </div>
            </>
          ) : null}
        </div>

        <Toast message={toast} />
      </div>
    );
  }

  if (!auth) {
    return (
      <div className="app-shell min-h-screen text-gold-100">
        <div className="mx-auto max-w-4xl px-4 py-8">
          <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
            <BrandLockup
              title="Welcome to Poker House"
              subtitle="Choose one option to continue. New players send a join request and banker approval is required."
            />
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full border border-gold-500/30 bg-black/30 px-3 py-1 text-xs text-gold-100/80">{userAuth.email}</span>
              <button className="btn-ghost text-sm" onClick={logoutAccount}>
                Logout Account
              </button>
            </div>
          </header>

          {entryMode === "CHOICE" ? (
            <div className="grid gap-4 md:grid-cols-3">
              <button className="card interactive-tile text-left transition hover:border-gold-300/50" onClick={() => setEntryMode("CREATE")}>
                <h2 className="font-cinzel text-xl">Create Room</h2>
                <p className="mt-1 text-sm text-gold-100/70">Banker creates a new room and controls approvals.</p>
              </button>
              <button className="card interactive-tile text-left transition hover:border-gold-300/50" onClick={() => setEntryMode("JOIN")}>
                <h2 className="font-cinzel text-xl">Join Room</h2>
                <p className="mt-1 text-sm text-gold-100/70">Send join request to banker for approval.</p>
              </button>
              <button className="card interactive-tile text-left transition hover:border-gold-300/50" onClick={() => setEntryMode("EXISTING")}>
                <h2 className="font-cinzel text-xl">Existing Room</h2>
                <p className="mt-1 text-sm text-gold-100/70">Return to a room you have already played in.</p>
              </button>
            </div>
          ) : null}

          {entryMode === "CREATE" ? (
            <form onSubmit={createHouse} className="card mx-auto max-w-xl space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="font-cinzel text-xl">Create Room (Banker)</h2>
                <button className="btn-ghost text-sm" type="button" onClick={() => setEntryMode("CHOICE")}>
                  Back
                </button>
              </div>
              <input
                className="input"
                placeholder="Room name"
                value={houseCreateForm.roomName}
                onChange={(e) => setHouseCreateForm((s) => ({ ...s, roomName: e.target.value }))}
              />
              <input
                className="input"
                placeholder="Banker name"
                value={houseCreateForm.bankerName}
                onChange={(e) => setHouseCreateForm((s) => ({ ...s, bankerName: e.target.value }))}
              />
              <input
                className="input"
                placeholder="4-6 digit banker PIN"
                value={houseCreateForm.bankerPin}
                onChange={(e) => setHouseCreateForm((s) => ({ ...s, bankerPin: e.target.value }))}
              />
              <button disabled={busy} className="btn-gold w-full" type="submit">
                {busy ? "Creating..." : "Create Room"}
              </button>
            </form>
          ) : null}

          {entryMode === "JOIN" ? (
            <div className="mx-auto max-w-xl space-y-4">
              <form onSubmit={sendJoinRequest} className="card space-y-3">
                <div className="flex items-center justify-between">
                  <h2 className="font-cinzel text-xl">Join Room Request</h2>
                  <button className="btn-ghost text-sm" type="button" onClick={() => setEntryMode("CHOICE")}>
                    Back
                  </button>
                </div>
                <input
                  className="input"
                  placeholder="6-digit room code"
                  value={houseJoinRequestForm.roomCode}
                  onChange={(e) => setHouseJoinRequestForm((s) => ({ ...s, roomCode: e.target.value }))}
                />
                <input
                  className="input"
                  placeholder="Your name"
                  value={houseJoinRequestForm.playerName}
                  onChange={(e) => setHouseJoinRequestForm((s) => ({ ...s, playerName: e.target.value }))}
                />
                <button disabled={busy} className="btn-gold w-full" type="submit">
                  {busy ? "Sending..." : "Send Join Request"}
                </button>
              </form>

              {joinRequestTicket ? (
                <div className="card">
                  <h3 className="font-cinzel text-lg">Request Status</h3>
                  <p className="mt-1 text-sm text-gold-100/70">
                    Room {joinRequestTicket.roomCode} • Request {joinRequestTicket.request.requestId}
                  </p>
                  <p className="mt-2 text-sm">
                    Status: <span className="font-semibold">{joinRequestTicket.request.status}</span>
                  </p>
                  {joinRequestTicket.request.reason ? (
                    <p className="mt-1 text-sm text-red-200">Reason: {joinRequestTicket.request.reason}</p>
                  ) : null}
                  <button className="btn-gold mt-3 w-full" onClick={checkJoinRequestStatus} disabled={busy}>
                    {busy ? "Checking..." : "Check Approval Status"}
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}

          {entryMode === "EXISTING" ? (
            <div className="mx-auto max-w-xl space-y-4">
              <div className="card">
                <div className="mb-3 flex items-center justify-between">
                  <h2 className="font-cinzel text-xl">Existing Room Login</h2>
                  <button className="btn-ghost text-sm" type="button" onClick={() => setEntryMode("CHOICE")}>
                    Back
                  </button>
                </div>

                <div className="mb-3 grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    className={existingRoomRole === "PLAYER" ? "btn-gold w-full" : "btn-ghost w-full"}
                    onClick={() => setExistingRoomRole("PLAYER")}
                  >
                    Player
                  </button>
                  <button
                    type="button"
                    className={existingRoomRole === "BANKER" ? "btn-gold w-full" : "btn-ghost w-full"}
                    onClick={() => setExistingRoomRole("BANKER")}
                  >
                    Banker
                  </button>
                </div>

                {existingRoomRole === "BANKER" ? (
                  <form onSubmit={loginHouseBanker} className="space-y-3">
                    <input
                      className="input"
                      placeholder="6-digit room code"
                      value={houseBankerLoginForm.roomCode}
                      onChange={(e) => setHouseBankerLoginForm((s) => ({ ...s, roomCode: e.target.value }))}
                    />
                    <input
                      className="input"
                      placeholder="Banker PIN"
                      value={houseBankerLoginForm.bankerPin}
                      onChange={(e) => setHouseBankerLoginForm((s) => ({ ...s, bankerPin: e.target.value }))}
                    />
                    <button disabled={busy} className="btn-gold w-full" type="submit">
                      {busy ? "Logging in..." : "Open Banker Dashboard"}
                    </button>
                  </form>
                ) : (
                  <form onSubmit={loginExistingMember} className="space-y-3">
                    <input
                      className="input"
                      placeholder="6-digit room code"
                      value={houseExistingPlayerForm.roomCode}
                      onChange={(e) => setHouseExistingPlayerForm((s) => ({ ...s, roomCode: e.target.value }))}
                    />
                    <input
                      className="input"
                      placeholder="Saved member id (optional)"
                      value={houseExistingPlayerForm.userId}
                      onChange={(e) => setHouseExistingPlayerForm((s) => ({ ...s, userId: e.target.value }))}
                    />
                    <input
                      className="input"
                      placeholder="Player name (if no member id)"
                      value={houseExistingPlayerForm.playerName}
                      onChange={(e) => setHouseExistingPlayerForm((s) => ({ ...s, playerName: e.target.value }))}
                    />
                    <button disabled={busy} className="btn-gold w-full" type="submit">
                      {busy ? "Logging in..." : "Open Player Dashboard"}
                    </button>
                  </form>
                )}
              </div>
            </div>
          ) : null}
        </div>

        <Toast message={toast} />
      </div>
    );
  }

  if (!room) {
    return (
      <div className="app-shell grid min-h-screen place-items-center">
        <div className="card">Loading room state...</div>
      </div>
    );
  }

  return (
    <div className="app-shell min-h-screen text-gold-100">
      <div className="mx-auto max-w-7xl px-4 py-6">
        <header className="header-glass mb-4 rounded-2xl border border-gold-500/20 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <BrandLockup
              title={`Room ${room.code}`}
              subtitle={`Banker: ${room.bankerName} • 1 Buy-In: ${toCash(room.buyInCash || room.buyInValue)} = ${
                room.buyInChips || room.buyInValue
              } chips`}
            />
            <div className="flex flex-wrap gap-2">
              <span className="rounded-full border border-gold-500/30 bg-black/30 px-3 py-1 text-xs text-gold-100/80">{userAuth.email}</span>
              <span className={`rounded-full border px-3 py-1 text-xs ${statusBadge(room.status)}`}>{room.status}</span>
              <span
                className={`live-pill rounded-full border px-3 py-1 text-xs ${
                  isConnected ? "border-emerald-500/40 bg-emerald-500/20 text-emerald-100" : "border-red-500/40 bg-red-500/20 text-red-100"
                }`}
              >
                {isConnected ? "Live" : "Reconnecting"}
              </span>
              <button onClick={copyShareLink} className="btn-ghost text-sm">
                Share Link
              </button>
              {auth.role === "BANKER" ? (
                <button onClick={openPlayerTab} className="btn-ghost text-sm">
                  Open Player Tab
                </button>
              ) : null}
              <button onClick={shareWhatsApp} className="btn-ghost text-sm">
                WhatsApp
              </button>
              <button onClick={() => setSoundOn((s) => !s)} className="btn-ghost text-sm">
                Sound: {soundOn ? "On" : "Off"}
              </button>
              {houseAuth ? (
                <button onClick={backToRoomLeaderboard} className="btn-ghost text-sm">
                  Room Leaderboard
                </button>
              ) : null}
              <button onClick={logoutSession} className="btn-ghost text-sm">
                Leave Session
              </button>
              <button onClick={logoutAccount} className="btn-ghost text-sm">
                Logout Account
              </button>
            </div>
          </div>
        </header>

        <div className="mb-4 grid gap-3 sm:grid-cols-4">
          <Metric label="Chips Issued" value={room.totals?.totalBuyIns || 0} />
          <Metric label="Chips Returned" value={room.totals?.totalReturned || 0} />
          <Metric label="Bank Liability (chips)" value={room.totals?.totalLiability || 0} />
          <Metric label="Players" value={room.players.length} />
        </div>

        {auth.role === "BANKER" ? (
          <BankerView
            room={room}
            pendingRequests={pendingRequests}
            rejectReason={rejectReason}
            setRejectReason={setRejectReason}
            resolveRequest={resolveRequest}
            toggleLock={toggleLock}
            endSession={endSession}
            exportCsv={exportCsv}
            freezePlayer={freezePlayer}
            promoteCoBanker={promoteCoBanker}
            undoLastAction={undoLastAction}
            adjustment={adjustment}
            setAdjustment={setAdjustment}
            applyAdjustment={applyAdjustment}
            cashoutInputByPlayer={cashoutInputByPlayer}
            setCashoutInputByPlayer={setCashoutInputByPlayer}
            setCashoutForPlayer={setCashoutForPlayer}
            approveCashout={approveCashout}
            finalizeSettlement={finalizeSettlement}
          />
        ) : (
          <PlayerView
            room={room}
            myPlayer={myPlayer}
            requestForm={requestForm}
            setRequestForm={setRequestForm}
            requestBuyIn={requestBuyIn}
            requestReturn={requestReturn}
            myCashoutInput={myCashoutInput}
            setMyCashoutInput={setMyCashoutInput}
            submitMyCashout={submitMyCashout}
          />
        )}
      </div>

      <AnimatePresence>
        {pendingAlert ? (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 20 }}
            className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-xl border border-gold-500/30 bg-black/70 px-4 py-2 text-sm shadow-glow"
          >
            {pendingAlert}
          </motion.div>
        ) : null}
      </AnimatePresence>

      <Toast message={toast} />
    </div>
  );
}

function connectSocketProxy(token, setRoom, setToast, role, setPendingAlert, setIsConnected, soundOn) {
  if (!token) return null;
  const socket = connectSocket(token);

  socket.on("connect", () => {
    setIsConnected(true);
    socket.emit("room:subscribe");
  });
  socket.on("disconnect", () => setIsConnected(false));
  socket.on("session:state", (data) => setRoom(data.room));
  socket.on("session:update", (data) => setRoom(data.room));
  socket.on("session_state_updated", (data) => setRoom(data.room));
  socket.on("cashout_opened", () => setToast("Cash-out phase started. Enter ending chips."));
  socket.on("session_ended", (data) => {
    setToast(`Session ended at ${new Date(data.endedAt).toLocaleTimeString()}`);
  });
  socket.on("request:new", ({ request }) => {
    if (role === "BANKER") {
      setPendingAlert(`${request.playerName} requested ${toMoney(request.amount)} (${request.type.replace("_", " ")})`);
      setTimeout(() => setPendingAlert(""), 3500);
      if (soundOn) {
        // Lightweight notification sound without external assets.
        const audio = new Audio("data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAIlYAAESsAAACABAAZGF0YQAAAAA=");
        audio.play().catch(() => {});
      }
    }
  });
  socket.on("request_created", ({ request }) => {
    if (role === "BANKER") {
      setPendingAlert(`${request.playerName} requested ${toMoney(request.amount)} (${request.type.replace("_", " ")})`);
      setTimeout(() => setPendingAlert(""), 3500);
    }
  });
  socket.on("request_updated", () => {
    // state is already refreshed through session_state_updated/session:update
  });
  socket.on("cashout_submitted", () => {
    if (role === "BANKER") setToast("A player submitted cash-out chips");
  });
  socket.on("cashout_updated", () => {
    // state already updated through session update stream
  });
  socket.on("error:domain", ({ message }) => setToast(message));

  return socket;
}

function GoldenSpadeLogo({ size = 52 }) {
  return (
    <span className="brand-logo-shell" style={{ width: size, height: size }}>
      <svg className="spade-logo" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <defs>
          <linearGradient id="spadeGoldFill" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#FFE9B4" />
            <stop offset="52%" stopColor="#D9A54A" />
            <stop offset="100%" stopColor="#8B621D" />
          </linearGradient>
          <linearGradient id="spadeShine" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#FFF6DE" stopOpacity="0.95" />
            <stop offset="100%" stopColor="#FFF6DE" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path
          d="M50 8C39 21 22 32 22 52C22 65 31 73 43 73C46 73 49 72 50 70C51 72 54 73 57 73C69 73 78 65 78 52C78 32 61 21 50 8Z"
          fill="url(#spadeGoldFill)"
          stroke="#F5D088"
          strokeOpacity="0.95"
          strokeWidth="1.8"
        />
        <path d="M43 73C45 79 42 84 37 90H63C58 84 55 79 57 73H43Z" fill="url(#spadeGoldFill)" stroke="#F5D088" strokeWidth="1.2" />
        <path d="M50 17C42 27 31 35 31 49C31 57 36 62 43 62C46 62 48 61 50 59C52 61 54 62 57 62C64 62 69 57 69 49C69 35 58 27 50 17Z" fill="url(#spadeShine)" />
      </svg>
    </span>
  );
}

function BrandLockup({ title, subtitle, centered = false }) {
  return (
    <div className={`brand-lockup ${centered ? "centered" : ""}`}>
      <GoldenSpadeLogo size={centered ? 58 : 50} />
      <div>
        <h1 className={`font-cinzel ${centered ? "text-3xl" : "text-2xl"} font-black tracking-wide`}>{title}</h1>
        {subtitle ? <p className="brand-subtitle text-sm">{subtitle}</p> : null}
      </div>
    </div>
  );
}

function Metric({ label, value }) {
  return (
    <div className="rounded-xl border border-gold-500/20 bg-black/30 p-3">
      <div className="text-xs text-gold-100/70">{label}</div>
      <div className="font-cinzel text-xl font-bold">{value}</div>
    </div>
  );
}

function BankerView({
  room,
  pendingRequests,
  rejectReason,
  setRejectReason,
  resolveRequest,
  toggleLock,
  endSession,
  exportCsv,
  freezePlayer,
  promoteCoBanker,
  undoLastAction,
  adjustment,
  setAdjustment,
  applyAdjustment,
  cashoutInputByPlayer,
  setCashoutInputByPlayer,
  setCashoutForPlayer,
  approveCashout,
  finalizeSettlement,
}) {
  const inCashout = room.status === "CASHOUT";

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <div className="space-y-4 lg:col-span-2">
        <div className="card">
          <div className="mb-3 flex flex-wrap gap-2">
            <button onClick={toggleLock} className="btn-gold text-sm">
              {room.sessionLocked ? "Unlock Session" : "Lock Session"}
            </button>
            <button onClick={endSession} className="btn-ghost text-sm">
              {inCashout ? "Cash-out Open" : "End Session (Open Cash-out)"}
            </button>
            {inCashout ? (
              <button onClick={finalizeSettlement} className="btn-gold text-sm">
                Finalize Settlement
              </button>
            ) : null}
            <button onClick={undoLastAction} className="btn-ghost text-sm">
              Undo Last (2 min)
            </button>
            <button onClick={exportCsv} className="btn-ghost text-sm">
              Export Settlement CSV
            </button>
          </div>
          <p className="text-sm text-gold-100/70">Cash-out formula: (Ending Chips + Returned Chips) - Issued Chips = Net Chips.</p>
          <p className="text-sm text-gold-100/70">Net Cash = Net Chips × (BuyInCash / BuyInChips).</p>
          {room.totals?.tallyMismatch ? (
            <div className="mt-2 rounded-lg border border-red-500/40 bg-red-500/10 p-2 text-xs text-red-200">
              Tally mismatch • Missing cash-out: {room.totals?.missingCashoutCount || 0} • Chip delta: {room.totals?.chipDelta || 0} • Cash delta:{" "}
              {toCash(room.totals?.cashDelta || 0)}
            </div>
          ) : null}
        </div>

        <div className="card overflow-x-auto">
          <h3 className="mb-3 font-cinzel text-xl">Player Balances</h3>
          <table className="min-w-full text-sm">
            <thead className="text-gold-100/70">
              <tr>
                <th className="px-2 py-2 text-left">Seat</th>
                <th className="px-2 py-2 text-left">Player</th>
                <th className="px-2 py-2 text-right">Buy-In</th>
                <th className="px-2 py-2 text-right">Returned</th>
                <th className="px-2 py-2 text-right">Ending Chips</th>
                <th className="px-2 py-2 text-right">Net Chips</th>
                <th className="px-2 py-2 text-right">Net Position</th>
                <th className="px-2 py-2 text-right">Win/Loss</th>
                <th className="px-2 py-2 text-right">Controls</th>
              </tr>
            </thead>
            <tbody>
              {room.players.map((p) => (
                <tr key={p.playerId} className="border-t border-gold-500/10">
                  <td className="px-2 py-2">{p.seatNo}</td>
                  <td className="px-2 py-2">
                    {p.name}
                    {p.role === "CO_BANKER" ? <span className="ml-2 rounded border border-gold-500/40 px-1 text-[10px]">CO</span> : null}
                    {p.frozen ? <span className="ml-2 rounded border border-red-500/40 px-1 text-[10px] text-red-200">FROZEN</span> : null}
                  </td>
                  <td className="px-2 py-2 text-right">{p.totalBuyIns}</td>
                  <td className="px-2 py-2 text-right">{p.totalReturned}</td>
                  <td className="px-2 py-2 text-right">{p.endingChips ?? "-"}</td>
                  <td className="px-2 py-2 text-right">{p.netChips || 0}</td>
                  <td className="px-2 py-2 text-right">{p.netPosition || 0}</td>
                  <td className={`px-2 py-2 text-right ${p.netCash >= 0 ? "text-emerald-300" : "text-red-300"}`}>
                    {toCash(p.netCash || 0)}
                  </td>
                  <td className="px-2 py-2 text-right">
                    <div className="flex flex-wrap justify-end gap-1">
                      <button className="btn-ghost px-2 py-1 text-[11px]" onClick={() => freezePlayer(p.playerId, !p.frozen)}>
                        {p.frozen ? "Unfreeze" : "Freeze"}
                      </button>
                      <button className="btn-ghost px-2 py-1 text-[11px]" onClick={() => promoteCoBanker(p.playerId, p.role !== "CO_BANKER")}>
                        {p.role === "CO_BANKER" ? "Demote" : "Co-Banker"}
                      </button>
                      <button
                        className="btn-ghost px-2 py-1 text-[11px]"
                        onClick={() => setAdjustment((s) => ({ ...s, playerId: p.playerId }))}
                      >
                        Adjust
                      </button>
                      {inCashout ? (
                        <>
                          <input
                            className="input w-24 px-2 py-1 text-[11px]"
                            type="number"
                            min={0}
                            placeholder="chips"
                            value={cashoutInputByPlayer[p.playerId] ?? ""}
                            onChange={(e) =>
                              setCashoutInputByPlayer((s) => ({
                                ...s,
                                [p.playerId]: e.target.value,
                              }))
                            }
                          />
                          <button className="btn-ghost px-2 py-1 text-[11px]" onClick={() => setCashoutForPlayer(p.playerId)}>
                            Set
                          </button>
                          <button className="btn-ghost px-2 py-1 text-[11px]" onClick={() => approveCashout(p.playerId)}>
                            Approve
                          </button>
                        </>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="card">
          <h3 className="mb-3 font-cinzel text-xl">Manual Adjustment</h3>
          <div className="grid gap-2 sm:grid-cols-4">
            <select
              className="input"
              value={adjustment.playerId}
              onChange={(e) => setAdjustment((s) => ({ ...s, playerId: e.target.value }))}
            >
              <option value="">Select player</option>
              {room.players.map((p) => (
                <option key={p.playerId} value={p.playerId}>
                  {p.name}
                </option>
              ))}
            </select>
            <input
              className="input"
              type="number"
              value={adjustment.deltaBuyIns}
              onChange={(e) => setAdjustment((s) => ({ ...s, deltaBuyIns: Number(e.target.value) }))}
              placeholder="Delta Buy-In"
            />
            <input
              className="input"
              type="number"
              value={adjustment.deltaReturned}
              onChange={(e) => setAdjustment((s) => ({ ...s, deltaReturned: Number(e.target.value) }))}
              placeholder="Delta Returned"
            />
            <button className="btn-gold" onClick={applyAdjustment}>
              Apply
            </button>
          </div>
          <input
            className="input mt-2"
            placeholder="Reason (required by policy)"
            value={adjustment.reason}
            onChange={(e) => setAdjustment((s) => ({ ...s, reason: e.target.value }))}
          />
        </div>

        {room.status === "ENDED" && room.settlementTransfers?.length > 0 ? (
          <div className="card">
            <h3 className="mb-2 font-cinzel text-xl">Settlement Report</h3>
            <div className="space-y-2 text-sm">
              {room.settlementTransfers.map((t, idx) => (
                <div key={`${t.fromPlayerId}-${t.toPlayerId}-${idx}`} className="rounded-lg border border-gold-500/20 p-2">
                  {t.fromName} owes {t.toName} <span className="font-bold text-gold-300">{toCash(t.amount)}</span>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        <div className="card">
          <h3 className="mb-2 font-cinzel text-xl">History Timeline</h3>
          <div className="max-h-64 space-y-2 overflow-auto text-sm">
            {room.transactions?.length ? (
              room.transactions
                .slice()
                .reverse()
                .map((t) => (
                  <div key={t.transactionId} className="rounded-lg border border-gold-500/20 p-2">
                    <div className="font-medium">
                      {t.type.replace(/_/g, " ")} • {t.playerName || "-"} • {toMoney(t.amount)}
                    </div>
                    <div className="text-xs text-gold-100/70">
                      ΔBuyIn {t.deltaBuyIns} / ΔReturn {t.deltaReturned} • {new Date(t.createdAt).toLocaleTimeString()}
                    </div>
                  </div>
                ))
            ) : (
              <div className="text-gold-100/60">No transactions yet</div>
            )}
          </div>
        </div>
      </div>

      <div className="card">
        <h3 className="mb-3 font-cinzel text-xl">Pending Requests</h3>
        <div className="space-y-3">
          {pendingRequests.length === 0 ? <p className="text-sm text-gold-100/60">No pending requests</p> : null}
          <AnimatePresence>
            {pendingRequests.map((r) => (
              <motion.div
                key={r.requestId}
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -12 }}
                className="rounded-xl border border-gold-500/20 bg-black/30 p-3"
              >
                <div className="mb-1 text-sm font-semibold">{r.playerName}</div>
                <div className="text-xs text-gold-100/70">
                  {r.type.replace("_", " ")} • {toMoney(r.amount)}
                </div>
                <input
                  className="input mt-2"
                  placeholder="Reject reason (optional)"
                  value={rejectReason[r.requestId] || ""}
                  onChange={(e) =>
                    setRejectReason((s) => ({
                      ...s,
                      [r.requestId]: e.target.value,
                    }))
                  }
                />
                <div className="mt-2 flex gap-2">
                  <button className="btn-gold text-xs" onClick={() => resolveRequest(r.requestId, "APPROVE")}>
                    Approve
                  </button>
                  <button className="btn-ghost text-xs" onClick={() => resolveRequest(r.requestId, "REJECT")}>
                    Reject
                  </button>
                </div>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}

function PlayerView({
  room,
  myPlayer,
  requestForm,
  setRequestForm,
  requestBuyIn,
  requestReturn,
  myCashoutInput,
  setMyCashoutInput,
  submitMyCashout,
}) {
  const inCashout = room.status === "CASHOUT";
  const frozen = room.status === "ENDED" || room.sessionLocked || !!myPlayer?.frozen;

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <div className="space-y-4 lg:col-span-2">
        <div className="card">
          <h3 className="mb-3 font-cinzel text-xl">Your Console</h3>
          <div className="grid gap-3 sm:grid-cols-3">
            <Metric label="Chip Balance" value={(myPlayer?.totalBuyIns || 0) - (myPlayer?.totalReturned || 0)} />
            <Metric label="Total Buy-Ins (chips)" value={myPlayer?.totalBuyIns || 0} />
            <Metric label="Net Result" value={toCash(myPlayer?.netCash || 0)} />
          </div>
        </div>

        {!inCashout ? (
          <div className="card">
            <h3 className="mb-3 font-cinzel text-xl">Request Actions</h3>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="mb-1 block text-xs text-gold-100/70">Request Buy-In Amount</label>
                <input
                  className="input"
                  type="number"
                  min={1}
                  value={requestForm.buyInAmount}
                  onChange={(e) => setRequestForm((s) => ({ ...s, buyInAmount: Number(e.target.value) }))}
                />
                <button disabled={frozen} className="btn-gold mt-2 w-full" onClick={requestBuyIn}>
                  Request Buy-In
                </button>
              </div>
              <div>
                <label className="mb-1 block text-xs text-gold-100/70">Request Return Amount</label>
                <input
                  className="input"
                  type="number"
                  min={1}
                  value={requestForm.returnAmount}
                  onChange={(e) => setRequestForm((s) => ({ ...s, returnAmount: Number(e.target.value) }))}
                />
                <button disabled={frozen || room.allowReturns === false} className="btn-ghost mt-2 w-full" onClick={requestReturn}>
                  Request Return
                </button>
                {room.allowReturns === false ? <p className="mt-1 text-xs text-orange-200">Returns disabled by banker.</p> : null}
              </div>
            </div>
            {frozen ? <p className="mt-2 text-sm text-orange-200">Requests are currently disabled for you.</p> : null}
          </div>
        ) : (
          <div className="card">
            <h3 className="mb-3 font-cinzel text-xl">Cash-Out Submission</h3>
            <label className="mb-1 block text-xs text-gold-100/70">Enter your ending chips</label>
            <div className="flex gap-2">
              <input
                className="input"
                type="number"
                min={0}
                value={myCashoutInput}
                onChange={(e) => setMyCashoutInput(Number(e.target.value))}
              />
              <button className="btn-gold" onClick={submitMyCashout}>
                Submit
              </button>
            </div>
            <p className="mt-2 text-xs text-gold-100/70">
              Submitted: {myPlayer?.cashoutSubmittedChips ?? "-"} • Approved ending: {myPlayer?.endingChips ?? "-"}
            </p>
          </div>
        )}

        <div className="card">
          <h3 className="mb-3 font-cinzel text-xl">Live Scoreboard</h3>
          <div className="space-y-2 text-sm">
            {room.players
              ?.slice()
              .sort((a, b) => (b.netPosition || 0) - (a.netPosition || 0))
              .map((p) => (
                <div key={p.playerId} className="flex items-center justify-between rounded-lg border border-gold-500/20 p-2">
                  <div>{p.name}</div>
                  <div className="text-gold-300">{(p.totalBuyIns || 0) - (p.totalReturned || 0)} chips</div>
                </div>
              ))}
          </div>
        </div>
      </div>

      <div className="card">
        <h3 className="mb-3 font-cinzel text-xl">Your Request History</h3>
        <div className="space-y-2 text-sm">
          {room.requests?.length ? (
            room.requests
              .slice()
              .reverse()
              .map((r) => (
                <div key={r.requestId} className="rounded-lg border border-gold-500/20 p-2">
                  <div>{r.type.replace("_", " ")} • {toMoney(r.amount)}</div>
                  <div className="text-xs text-gold-100/70">Status: {r.status}</div>
                  {r.reason ? <div className="text-xs text-red-200">Reason: {r.reason}</div> : null}
                </div>
              ))
          ) : (
            <div className="text-gold-100/60">No requests yet</div>
          )}
        </div>
      </div>
    </div>
  );
}

function GoogleSignInButton({ clientId, onCredential, onFailure, helperText = "", disabled = false }) {
  const buttonRef = useRef(null);
  const onCredentialRef = useRef(onCredential);
  const onFailureRef = useRef(onFailure);

  useEffect(() => {
    onCredentialRef.current = onCredential;
  }, [onCredential]);

  useEffect(() => {
    onFailureRef.current = onFailure;
  }, [onFailure]);

  useEffect(() => {
    if (!clientId || !buttonRef.current) return;
    const googleId = window.google?.accounts?.id;
    if (!googleId) return;

    googleId.initialize({
      client_id: clientId,
      callback: (response) => {
        if (response?.credential) {
          onCredentialRef.current?.(response.credential);
          return;
        }
        onFailureRef.current?.("Google Sign-In failed");
      },
    });

    buttonRef.current.innerHTML = "";
    googleId.renderButton(buttonRef.current, {
      theme: "outline",
      size: "large",
      text: "continue_with",
      shape: "pill",
      width: 320,
    });
  }, [clientId]);

  return (
    <div className={disabled ? "pointer-events-none opacity-60" : ""}>
      <div ref={buttonRef} className="flex justify-center" />
      {helperText ? <div className="mt-1 text-center text-xs text-gold-100/60">{helperText}</div> : null}
    </div>
  );
}

function Toast({ message }) {
  return (
    <AnimatePresence>
      {message ? (
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 20 }}
          className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-xl border border-gold-500/30 bg-black/80 px-4 py-2 text-sm text-gold-100"
        >
          {message}
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
