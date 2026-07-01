/*
  Warnings:

  - You are about to drop the column `colors` on the `brand_guidelines` table. All the data in the column will be lost.
  - You are about to drop the column `fonts` on the `brand_guidelines` table. All the data in the column will be lost.
  - You are about to drop the column `tones` on the `brand_guidelines` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "brand_guidelines" DROP COLUMN "colors",
DROP COLUMN "fonts",
DROP COLUMN "tones",
ADD COLUMN     "company_description" TEXT,
ADD COLUMN     "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "font_family" TEXT,
ADD COLUMN     "primary_color" TEXT,
ADD COLUMN     "secondary_color" TEXT,
ADD COLUMN     "tone_of_voice" TEXT;
