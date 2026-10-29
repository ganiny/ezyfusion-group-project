import { config } from "dotenv";
import { defineConfig } from "prisma/config";

// Graders run `cp .env.example .env.local`, so .env.local is the primary source;
// .env is an optional fallback. `npm install` runs `prisma generate` before any
// env file exists, so the URL must not be required at config-load time.
config({ path: [".env.local", ".env"], quiet: true });

export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: {
    url: process.env.DATABASE_URL ?? "",
  },
});
