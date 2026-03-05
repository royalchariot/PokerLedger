import createError from "http-errors";
import { OAuth2Client } from "google-auth-library";
import { env } from "../config/env.js";

let cachedGoogleClient = null;

function getGoogleClient() {
  if (!env.googleClientId) {
    throw createError(503, "Google Sign-In is not configured on server");
  }
  if (!cachedGoogleClient) {
    cachedGoogleClient = new OAuth2Client(env.googleClientId);
  }
  return cachedGoogleClient;
}

export async function verifyGoogleIdToken(rawCredential) {
  const credential = String(rawCredential || "").trim();
  if (!credential) throw createError(400, "Missing Google credential");

  const client = getGoogleClient();

  let ticket;
  try {
    ticket = await client.verifyIdToken({
      idToken: credential,
      audience: env.googleClientId,
    });
  } catch {
    throw createError(401, "Invalid Google credential");
  }

  const payload = ticket.getPayload();
  if (!payload?.sub) throw createError(401, "Invalid Google account payload");
  if (!payload.email || payload.email_verified !== true) {
    throw createError(401, "Google account email is not verified");
  }

  const email = String(payload.email).trim().toLowerCase();
  const fallbackName = email.includes("@") ? email.split("@")[0] : "Player";
  const name = String(payload.name || payload.given_name || fallbackName).trim() || fallbackName;

  return {
    sub: String(payload.sub),
    email,
    name,
  };
}
