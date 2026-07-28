// Prints a base64-encoded, cookies-only copy of storage-state.json for use as
// the NAUKRI_STORAGE_STATE_B64 GitHub secret.
//
// GitHub caps each Actions secret at 48 KB. A full Playwright storage state
// includes Naukri's localStorage (analytics/UI state, ~340 KB), which blows
// past that limit. The login itself lives in the cookies, so we keep only
// those — the result is a few KB and decodes back into a valid session.
//
//   node export-session.js | pbcopy      # macOS: value is now on your clipboard
//   node export-session.js | xclip -sel c   # Linux (X11)
//   node export-session.js > session.b64  # or write to a file
//
// The daily.yml workflow decodes it with `base64 -d > storage-state.json`.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE = path.join(__dirname, 'storage-state.json');

if (!fs.existsSync(STATE)) {
  console.error('❌ storage-state.json not found. Run `npm start` first to log in and create it.');
  process.exit(1);
}

const state = JSON.parse(fs.readFileSync(STATE, 'utf8'));
const cookies = state.cookies || [];
if (!cookies.length) {
  console.error('❌ No cookies in storage-state.json — the session looks empty. Re-run `npm start` and complete login.');
  process.exit(1);
}

// Keep cookies, drop origins (localStorage). Playwright accepts origins: [].
const trimmed = { cookies, origins: [] };
const b64 = Buffer.from(JSON.stringify(trimmed), 'utf8').toString('base64');

const kb = (b64.length / 1024).toFixed(1);
// Diagnostics go to stderr so `| pbcopy` only captures the base64 on stdout.
console.error(`✅ Encoded ${cookies.length} cookies → ${kb} KB base64 (GitHub secret limit: 48 KB).`);
process.stdout.write(b64);
