import bcrypt from "bcryptjs";
import { prisma } from "@/lib/db/client";
import type { RegisterInput } from "@/lib/validators/register.schema";

type RegisteredUser = {
  id: string;
  name: string | null;
  email: string;
  preferredLanguage: string;
};

type RegisterSuccess = { success: true; user: RegisteredUser };
type RegisterConflict = { success: false; code: "EMAIL_ALREADY_EXISTS" };

export type RegisterResult = RegisterSuccess | RegisterConflict;

export async function registerUser(data: RegisterInput): Promise<RegisterResult> {
  const email = data.email.trim().toLowerCase();

  const existing = await prisma.user.findUnique({
    where: { email },
    select: { id: true },
  });

  if (existing) {
    return { success: false, code: "EMAIL_ALREADY_EXISTS" };
  }

  const passwordHash = await bcrypt.hash(data.password, 12);

  const user = await prisma.user.create({
    data: {
      name: data.name,
      email,
      passwordHash,
      isGlobalAdmin: false,
      preferredLang: "en",
    },
    select: {
      id: true,
      name: true,
      email: true,
      preferredLang: true,
    },
  });

  return {
    success: true,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      preferredLanguage: user.preferredLang,
    },
  };
}
