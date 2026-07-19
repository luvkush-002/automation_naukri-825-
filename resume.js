// Resume re-upload flow.
// Pushes your local resume file (RESUME_PATH, default resume.pdf) to your
// Naukri profile, replacing the existing one. This also refreshes your
// profile's "last updated" timestamp, which is the signal that bumps you up
// in recruiter searches.
import fs from 'fs';
import path from 'path';
import {
  cfg, log, jitter, screenshot, STORAGE_STATE,
  requireCreds, launchContext, ensureLoggedIn, isMainModule,
} from './lib.js';

// The profile page's resume file input. Naukri has historically used
// id="attachCV"; we keep several fallbacks because the DOM drifts. The photo
// uploader is also an <input type="file">, so resume-specific selectors come
// first and the bare `input[type="file"]` is only a last resort.
const FILE_INPUT_SELECTORS = [
  'input#attachCV',
  'input[type="file"][name*="cv" i]',
  'input[type="file"][name*="resume" i]',
  'input[type="file"][accept*="pdf" i]',
  'input[type="file"][accept*="doc" i]',
  'input[type="file"]',
];

// Text/DOM signals that Naukri accepted the new resume.
const SUCCESS_SELECTORS = [
  'text=/resume has been successfully uploaded/i',
  'text=/successfully uploaded/i',
  'text=/uploaded successfully/i',
  'text=/resume.*updated/i',
];

// Uploads the resume in the given (already logged-in) context. Returns a small
// outcome object rather than throwing, so the orchestrator can carry on to the
// apply flow even if the upload fails.
export async function updateResume(context) {
  if (!cfg.resumePath || !fs.existsSync(cfg.resumePath)) {
    log(`⚠️  Resume file not found at "${cfg.resumePath}".`);
    log('   Set RESUME_PATH in .env or drop resume.pdf in the project root. Skipping resume update.');
    return { status: 'skipped', reason: 'file-not-found' };
  }

  const ext = path.extname(cfg.resumePath).toLowerCase();
  if (!['.pdf', '.doc', '.docx', '.rtf'].includes(ext)) {
    log(`⚠️  Resume "${path.basename(cfg.resumePath)}" has unsupported type "${ext}". Naukri accepts .pdf/.doc/.docx/.rtf. Skipping.`);
    return { status: 'skipped', reason: `unsupported-type:${ext}` };
  }

  const sizeMB = fs.statSync(cfg.resumePath).size / (1024 * 1024);
  log(`📄 Updating Naukri resume with "${path.basename(cfg.resumePath)}" (${sizeMB.toFixed(2)} MB)`);
  if (sizeMB > 2) {
    log('   ⚠️  File is over Naukri\'s 2MB limit — the upload will likely be rejected.');
  }

  const page = await context.newPage();
  try {
    await page.goto('https://www.naukri.com/mnjuser/profile', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await jitter(2000, 3000);

    // Scroll toward the resume section so lazy-rendered widgets mount.
    for (let i = 0; i < 4; i++) {
      await page.mouse.wheel(0, 1200);
      await jitter(400, 800);
    }

    let fileInput = null;
    for (const sel of FILE_INPUT_SELECTORS) {
      const cand = page.locator(sel).first();
      if (await cand.count()) {
        fileInput = cand;
        log(`   resume file input: "${sel}"`);
        break;
      }
    }

    if (!fileInput) {
      await screenshot(page, 'resume-no-input');
      log('⚠️  Could not find the resume file input on the profile page.');
      log('   Open your profile manually, Inspect the "Update resume" control, and add its selector to FILE_INPUT_SELECTORS in resume.js.');
      return { status: 'error', reason: 'no-file-input' };
    }

    // setInputFiles drives the <input> directly and works even when it's
    // visually hidden behind a styled "Update resume" button.
    await fileInput.setInputFiles(cfg.resumePath);
    log('   ⏳ File attached, waiting for Naukri to confirm...');

    const success = page.locator(SUCCESS_SELECTORS.join(', ')).first();
    try {
      await success.waitFor({ timeout: 30000 });
      await jitter(1500, 2500);
      await screenshot(page, 'resume-updated');
      log('✅ Resume updated on Naukri.');
      return { status: 'updated' };
    } catch {
      // No explicit toast — check whether the shown filename now matches ours,
      // which also indicates a successful replace.
      const shown = await page.locator('.fileName, .filename, [class*="fileName" i], [class*="resumeName" i]')
        .first().textContent().catch(() => '');
      const expected = path.basename(cfg.resumePath);
      if (shown && shown.toLowerCase().includes(expected.toLowerCase().replace(/\.[^.]+$/, '').slice(0, 12))) {
        await screenshot(page, 'resume-updated-byname');
        log(`✅ Resume appears updated (profile now shows "${shown.trim()}").`);
        return { status: 'updated', reason: 'matched-by-filename' };
      }
      await screenshot(page, 'resume-unconfirmed');
      log('⚠️  Upload sent but no success confirmation detected. Check the screenshot / your profile.');
      return { status: 'unknown', reason: 'no-confirmation' };
    }
  } catch (e) {
    await screenshot(page, 'resume-error');
    log('⚠️  Resume update failed:', e.message.slice(0, 200));
    return { status: 'error', reason: e.message.slice(0, 200) };
  } finally {
    await page.close().catch(() => {});
  }
}

// Standalone entry point: `node resume.js` — logs in and updates the resume.
if (isMainModule(import.meta.url)) {
  (async () => {
    requireCreds();
    log('🚀 Naukri resume update — starting');
    const { browser, context } = await launchContext();
    try {
      await ensureLoggedIn(context);
      const r = await updateResume(context);
      log(`📄 Resume update: ${r.status}${r.reason ? '  (' + r.reason + ')' : ''}`);
    } finally {
      await context.storageState({ path: STORAGE_STATE }).catch(() => {});
      await browser.close();
    }
  })().catch(err => {
    console.error('FATAL', err);
    process.exit(1);
  });
}
