import { Server } from "socket.io";
import jwt from "jsonwebtoken";

import { env } from "../config/env.js";
import { registerSocketHandlers } from "./handlers.js";

export function createSocketServer(httpServer) {
  const allowedOrigins = env.corsOrigin.split(",").map((x) => x.trim()).filter(Boolean);
  const io = new Server(httpServer, {
    cors: {
      origin: allowedOrigins,
      credentials: true,
    },
  });

  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error("Missing token"));
    try {
      const payload = jwt.verify(token, env.jwtSecret);
      socket.auth = payload;
      return next();
    } catch {
      return next(new Error("Invalid token"));
    }
  });

  io.on("connection", (socket) => {
    registerSocketHandlers(io, socket);
  });

  return io;
}
