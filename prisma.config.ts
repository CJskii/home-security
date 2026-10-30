import { config as loadEnv } from 'dotenv';
import { defineConfig } from 'prisma/config';

loadEnv({ quiet: true });

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  // Offline generation/validation do not need a URL. Deployment does.
  datasource: { url: process.env.DATABASE_URL ?? '' },
});
