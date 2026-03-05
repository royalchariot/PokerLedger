import mongoose from "mongoose";

const UserAccountSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true, unique: true, index: true },
    email: { type: String, required: true, unique: true, trim: true, lowercase: true },
    name: { type: String, required: true, trim: true, maxlength: 40 },
    passwordHash: { type: String, required: true },
    googleSub: { type: String, default: null },
    lastLoginAt: { type: Date, default: null },
  },
  { timestamps: true }
);

UserAccountSchema.index({ googleSub: 1 }, { unique: true, sparse: true });

export const UserAccount = mongoose.model("UserAccount", UserAccountSchema);
