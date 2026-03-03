import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { env } from "./config/env.js";

let memoryServer = null;

export async function connectDb() {
  mongoose.set("strictQuery", true);

  const uri = env.mongodbUri;
  if (uri) {
    await mongoose.connect(uri, { autoIndex: true });
    console.log("Connected MongoDB:", uri.replace(/:[^:@/]+@/, ":***@"));
    return;
  }

  memoryServer = await MongoMemoryServer.create();
  const memoryUri = memoryServer.getUri();
  await mongoose.connect(memoryUri, { autoIndex: true });
  console.log("Connected in-memory MongoDB for local development");
}
