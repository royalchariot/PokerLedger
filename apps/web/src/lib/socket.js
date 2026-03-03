import { io } from "socket.io-client";

const API_URL = import.meta.env.VITE_API_URL || "/api";
const ORIGIN = API_URL.replace(/\/api\/?$/, "");

export function connectSocket(token) {
  return io(ORIGIN, {
    transports: ["websocket"],
    auth: { token },
  });
}
