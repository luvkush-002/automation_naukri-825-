// Orchestrator for the scheduled daily run.
// Logs in ONCE, updates the resume, then runs the apply flow — all in a single
// browser session. This is what the GitHub Actions cron invokes.
import {
  cfg, log, STORAGE_STATE,
  requireCreds, launchContext, ensureLoggedIn,
} from './lib.js';
import { updateResume } from './resume.js';
import { runApply } from './apply.js';
import { runRecommended } from './recommended.js';
import { runEarlyAccess } from './early-access.js';

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

    // 3) Recommended jobs — homepage "View all", then every tab.
    //    Non-fatal, same as early access below.
    if (cfg.recommended) {
      try {
        await runRecommended(context, page);
      } catch (e) {
        log('⚠️  Recommended jobs flow threw:', e.message.slice(0, 200));
      }
    } else {
      log('⏭️  RECOMMENDED=false — skipping recommended jobs.');
    }

    // 4) Early access roles — share interest per the salary rule.
    //    Non-fatal: a failure here should not fail the whole daily run.
    if (cfg.earlyAccess) {
      try {
        await runEarlyAccess(context, page);
      } catch (e) {
        log('⚠️  Early access flow threw:', e.message.slice(0, 200));
      }
    } else {
      log('⏭️  EARLY_ACCESS=false — skipping early access roles.');
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
