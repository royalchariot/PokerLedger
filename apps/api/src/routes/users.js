import { Router } from "express";
import bcrypt from "bcryptjs";
import createError from "http-errors";
import { z } from "zod";

import { UserAccount } from "../models/UserAccount.js";
import { signAccessToken, authRequired } from "../middleware/auth.js";
import { validateBody } from "../middleware/validate.js";
import { verifyGoogleIdToken } from "../services/googleAuth.js";
import { randomId } from "../utils/code.js";

export const userRouter = Router();

const signupGoogleSchema = z.object({
  credential: z.string().trim().min(10),
  password: z.string().min(6).max(72),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6).max(72),
});

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function sanitizeName(name, fallback = "Player") {
  const next = String(name || "").trim();
  return (next || fallback).slice(0, 40);
}

function toUserPayload(user) {
  return {
    userId: user.userId,
    email: user.email,
    name: user.name,
  };
}

function signUserToken(user) {
  return signAccessToken({
    scope: "USER",
    role: "USER",
    actorId: user.userId,
    email: user.email,
    name: user.name,
  });
}

userRouter.post("/users/signup/google", validateBody(signupGoogleSchema), async (req, res, next) => {
  try {
    const google = await verifyGoogleIdToken(req.validatedBody.credential);
    const email = normalizeEmail(google.email);
    const passwordHash = await bcrypt.hash(req.validatedBody.password, 10);

    let user =
      (await UserAccount.findOne({ email })) ||
      (await UserAccount.findOne({ googleSub: google.sub }));

    let created = false;
    if (!user) {
      created = true;
      user = await UserAccount.create({
        userId: randomId("user"),
        email,
        name: sanitizeName(google.name, email.split("@")[0]),
        passwordHash,
        googleSub: google.sub,
        lastLoginAt: new Date(),
      });
    } else {
      if (user.googleSub && user.googleSub !== google.sub) {
        return next(createError(409, "Email is linked to a different Google account"));
      }
      user.email = email;
      user.name = sanitizeName(google.name, user.name);
      user.passwordHash = passwordHash;
      user.googleSub = google.sub;
      user.lastLoginAt = new Date();
      await user.save();
    }

    const token = signUserToken(user);
    res.status(created ? 201 : 200).json({
      token,
      user: toUserPayload(user),
      created,
    });
  } catch (err) {
    next(err);
  }
});

userRouter.post("/users/login", validateBody(loginSchema), async (req, res, next) => {
  try {
    const email = normalizeEmail(req.validatedBody.email);
    const user = await UserAccount.findOne({ email });
    if (!user) return next(createError(401, "Invalid email or password"));

    const ok = await bcrypt.compare(req.validatedBody.password, user.passwordHash);
    if (!ok) return next(createError(401, "Invalid email or password"));

    user.lastLoginAt = new Date();
    await user.save();

    const token = signUserToken(user);
    res.json({
      token,
      user: toUserPayload(user),
    });
  } catch (err) {
    next(err);
  }
});

userRouter.get("/users/me", authRequired, async (req, res, next) => {
  try {
    if (req.auth?.scope !== "USER") return next(createError(403, "Invalid auth scope"));
    const user = await UserAccount.findOne({ userId: req.auth.actorId });
    if (!user) return next(createError(404, "User not found"));
    res.json({ user: toUserPayload(user) });
  } catch (err) {
    next(err);
  }
});
