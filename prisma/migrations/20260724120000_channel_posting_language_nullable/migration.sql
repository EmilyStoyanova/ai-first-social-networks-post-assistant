-- Channel posting language becomes optional.
--
-- NULL now means "inherit the company brand default" (companies.default_language).
-- Existing rows keep their explicit "en"/"bg" values so current behaviour is
-- preserved exactly; only newly created channels (and channels the user sets to
-- "Use brand default") get NULL and follow the brand default.
ALTER TABLE "channel_configs" ALTER COLUMN "posting_language" DROP DEFAULT;
ALTER TABLE "channel_configs" ALTER COLUMN "posting_language" DROP NOT NULL;
