// Orchestrator for the scheduled daily run.
// Logs in ONCE, updates the resume, then runs the apply flow — all in a single
// browser session. This is what the GitHub Actions cron invokes.
import {
  cfg, log, STORAGE_STATE,
  requireCreds, launchContext, ensureLoggedIn,
} from './lib.js';
import { updateResume } from './resume.js';
import { runApply } from './apply.js';

(async () => {
  requireCreds();
  log('🗓️  Naukri daily run — resume update + auto-apply');

  const { browser, context } = await launchContext();
  try {
    const page = await ensureLoggedIn(context);

    // 1) Refresh the resume first (also bumps profile "last updated").
    //    Non-fatal: a resume failure should not block the apply flow.
    try {
      const r = await updateResume(context);
      log(`📄 Resume update: ${r.status}${r.reason ? '  (' + r.reason + ')' : ''}`);
    } catch (e) {
      log('⚠️  Resume update threw, continuing to apply:', e.message.slice(0, 200));
    }

    // 2) Apply to matching jobs.
    if (cfg.keywords.length) {
      await runApply(context, page);
    } else {
      log('⏭️  No KEYWORDS set — skipping the apply flow.');
    }

    // Persist the (refreshed) session so the next run reuses it.
    await context.storageState({ path: STORAGE_STATE });
  } finally {
    await browser.close();
  }
})().catch(err => {
  console.error('FATAL', err);
  process.exit(1);
});
