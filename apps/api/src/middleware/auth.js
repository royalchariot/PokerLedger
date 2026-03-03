import jwt from "jsonwebtoken";
import createError from "http-errors";
import { env } from "../config/env.js";

export function signAccessToken(payload) {
  return jwt.sign(payload, env.jwtSecret, { expiresIn: env.jwtTtl });
}

export function authRequired(req, _res, next) {
  const auth = req.headers.authorization || "";
  const [scheme, token] = auth.split(" ");

  if (scheme !== "Bearer" || !token) {
    return next(createError(401, "Missing bearer token"));
  }

  try {
    req.auth = jwt.verify(token, env.jwtSecret);
    return next();
  } catch {
    return next(createError(401, "Invalid token"));
  }
}

export function requireRole(...roles) {
  return function roleGuard(req, _res, next) {
    if (!req.auth || !roles.includes(req.auth.role)) {
      return next(createError(403, "Insufficient permissions"));
    }
    return next();
  };
}
