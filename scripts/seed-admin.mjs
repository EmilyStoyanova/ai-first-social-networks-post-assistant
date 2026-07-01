/**
 * DEV-ONLY seed: creates or promotes a user to global admin.
 * Idempotent — safe to run multiple times.
 *
 * Usage:  npm run seed:admin
 */

import "dotenv/config";
import { PrismaNeon } from "@prisma/adapter-neon";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const ADMIN_EMAIL = "admin@test.com";
const ADMIN_PASSWORD = "Password123!";
const ADMIN_NAME = "Admin";

const adapter = new PrismaNeon({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

async function main() {
  let user = await prisma.user.findUnique({
    where: { email: ADMIN_EMAIL },
    select: { id: true, isGlobalAdmin: true },
  });

  if (!user) {
    const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 12);
    user = await prisma.user.create({
      data: {
        name: ADMIN_NAME,
        email: ADMIN_EMAIL,
        passwordHash,
        isGlobalAdmin: true,
        preferredLang: "en",
      },
      select: { id: true, isGlobalAdmin: true },
    });
    console.log(`✓  Created global admin: ${ADMIN_EMAIL}`);
  } else if (!user.isGlobalAdmin) {
    await prisma.user.update({
      where: { id: user.id },
      data: { isGlobalAdmin: true },
    });
    console.log(`✓  Promoted existing user to global admin: ${ADMIN_EMAIL}`);
  } else {
    console.log(`✓  Global admin already configured: ${ADMIN_EMAIL}`);
  }

  console.log("\nCredentials:");
  console.log(`  Email:    ${ADMIN_EMAIL}`);
  console.log(`  Password: ${ADMIN_PASSWORD}`);
  console.log();
}

main()
  .catch((err) => {
    console.error("\n❌  Seed failed:", err.message ?? err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
