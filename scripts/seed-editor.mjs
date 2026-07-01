/**
 * DEV-ONLY seed: creates an EDITOR user and attaches it to a company.
 * Remove after Phase 4.2 (Company Members) ships the real invite flow.
 *
 * Usage:  npm run seed:editor
 */

import "dotenv/config";
import { PrismaNeon } from "@prisma/adapter-neon";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const COMPANY_NAME = "LudogorieSoft";
const EDITOR_EMAIL = "editor@test.com";
const EDITOR_PASSWORD = "Password123!";
const EDITOR_NAME = "Editor Test";

const adapter = new PrismaNeon({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

async function main() {
  // 1. Locate the company
  const company = await prisma.company.findFirst({
    where: { name: COMPANY_NAME },
    select: { id: true, name: true, slug: true },
  });

  if (!company) {
    console.log(
      `\n❌  Company "${COMPANY_NAME}" not found.\n    Create it first, then re-run this script.\n`,
    );
    return;
  }

  // 2. Upsert the editor user
  let user = await prisma.user.findUnique({
    where: { email: EDITOR_EMAIL },
    select: { id: true },
  });

  if (!user) {
    // Same cost factor as register.service.ts
    const passwordHash = await bcrypt.hash(EDITOR_PASSWORD, 12);
    user = await prisma.user.create({
      data: {
        name: EDITOR_NAME,
        email: EDITOR_EMAIL,
        passwordHash,
        isGlobalAdmin: false,
        preferredLang: "en",
      },
      select: { id: true },
    });
    console.log(`✓  Created user: ${EDITOR_EMAIL}`);
  } else {
    console.log(`✓  User already exists: ${EDITOR_EMAIL}`);
  }

  // 3. Upsert the membership
  const membership = await prisma.companyMember.findFirst({
    where: { userId: user.id, companyId: company.id },
    select: { id: true, role: true },
  });

  let membershipId;
  if (!membership) {
    const created = await prisma.companyMember.create({
      data: {
        companyId: company.id,
        userId: user.id,
        role: "editor",
      },
      select: { id: true },
    });
    membershipId = created.id;
    console.log(`✓  Added ${EDITOR_EMAIL} as EDITOR of "${company.name}"`);
  } else {
    membershipId = membership.id;
    console.log(`✓  Editor already configured (role: ${membership.role}).`);
  }

  // 4. Debug: re-fetch all memberships for this user and verify they resolve
  const allMemberships = await prisma.companyMember.findMany({
    where: { userId: user.id },
    select: {
      id: true,
      role: true,
      company: { select: { id: true, name: true, slug: true } },
    },
  });

  console.log("\n── Debug: DB state ─────────────────────────────────");
  console.log(`  Editor user id:   ${user.id}`);
  console.log(`  Company id:       ${company.id}`);
  console.log(`  Company name:     ${company.name}`);
  console.log(`  Company slug:     ${company.slug}`);
  console.log(`  Membership id:    ${membershipId}`);
  console.log(`  Membership role:  editor`);
  console.log(`  Total memberships for user: ${allMemberships.length}`);
  if (allMemberships.length === 0) {
    console.log("  ⚠️  No memberships found — listCompanies will return [].");
  }
  for (const m of allMemberships) {
    const companyResolved = m.company
      ? `"${m.company.name}" (slug: ${m.company.slug}, id: ${m.company.id})`
      : "⚠️  COMPANY NOT FOUND (stale foreign key)";
    console.log(`  • membership ${m.id} | role: ${m.role} | company: ${companyResolved}`);
  }
  console.log("────────────────────────────────────────────────────");

  // 5. Print credentials
  console.log("\nTest credentials:");
  console.log(`  Email:    ${EDITOR_EMAIL}`);
  console.log(`  Password: ${EDITOR_PASSWORD}`);
  console.log();
}

main()
  .catch((err) => {
    console.error("\n❌  Seed failed:", err.message ?? err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
