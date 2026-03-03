import http from "http";
import express from "express";
import helmet from "helmet";
import cors from "cors";
import cookieParser from "cookie-parser";
import rateLimit from "express-rate-limit";

import { env } from "./config/env.js";
import { connectDb } from "./db.js";
import { healthRouter } from "./routes/health.js";
import { roomRouter } from "./routes/rooms.js";
import { houseRoomRouter } from "./routes/houseRooms.js";
import { errorHandler, notFound } from "./middleware/error.js";
import { createSocketServer } from "./sockets/index.js";

const app = express();
const allowedOrigins = env.corsOrigin.split(",").map((x) => x.trim()).filter(Boolean);
app.set("trust proxy", 1);
const allowAllOrigins = allowedOrigins.includes("*");

app.use(helmet());
app.use(
  cors({
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      if (allowAllOrigins) return callback(null, true);
      if (env.nodeEnv !== "production") return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      return callback(new Error("CORS blocked"), false);
    },
    credentials: true,
  })
);

app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
});

app.use("/api", apiLimiter);
app.use("/api", healthRouter);
app.use("/api", roomRouter);
app.use("/api", houseRoomRouter);

app.use(notFound);
app.use(errorHandler);

async function bootstrap() {
  await connectDb();
  const server = http.createServer(app);
  const io = createSocketServer(server);
  app.locals.io = io;

  server.listen(env.port, () => {
    console.log(`API listening on http://localhost:${env.port}`);
  });
}

bootstrap().catch((err) => {
  console.error("Failed to start server", err);
  process.exit(1);
});
