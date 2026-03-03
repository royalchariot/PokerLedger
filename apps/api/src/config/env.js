import dotenv from "dotenv";

dotenv.config();

const required = ["JWT_SECRET"];
for (const key of required) {
  if (!process.env[key]) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
}

export const env = {
  nodeEnv: process.env.NODE_ENV || "development",
  port: Number(process.env.PORT || 4000),
  corsOrigin: process.env.CORS_ORIGIN || "http://localhost:5173,http://localhost:5174",
  mongodbUri: process.env.MONGODB_URI || "",
  jwtSecret: process.env.JWT_SECRET,
  jwtTtl: process.env.JWT_TTL || "12h",
  roomTtlHours: Number(process.env.ROOM_TTL_HOURS || 24),
  requestDedupMs: Number(process.env.REQUEST_DEDUP_MS || 15000),
};
