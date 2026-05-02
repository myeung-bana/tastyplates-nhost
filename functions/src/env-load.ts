/**
 * Load `.env` then `.env.local` from the `functions/` directory before any other
 * module reads `process.env` (e.g. Upstash `Redis.fromEnv()` at import time).
 *
 * Import this as the first side-effect in `server.ts` only — Nhost-deployed
 * function handlers get env from the platform and do not rely on this file.
 */
import path from 'path';
import dotenv from 'dotenv';

const functionsRoot = path.resolve(__dirname, '..');

dotenv.config({ path: path.join(functionsRoot, '.env') });
dotenv.config({ path: path.join(functionsRoot, '.env.local') });
