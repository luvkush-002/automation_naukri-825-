// Naukri "Early access roles" flow.
// Opens the Early access roles section (shown to you before the job goes live
// to everyone) and clicks "Share interest" on roles matching the salary rule:
//   - salary range shown:  share when lower bound >= EARLY_ACCESS_MIN_SALARY_LOWER
//                          (default 5 LPA) OR upper bound >= EARLY_ACCESS_MIN_SALARY_UPPER
//                          (default 9 LPA)
//   - no salary range / "Not disclosed": share interest anyway.
// Runs after the apply flow in the daily run (run.js); also runnable standalone
// via `npm run early-access`. Shared-interest role IDs are remembered in
// early-access-shared.json so re-runs don't re-process them.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  cfg, log, jitter, screenshot, STORAGE_STATE,
  requireCreds, launchContext, ensureLoggedIn, isMainModule,
} from './lib.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHARED_LOG = path.join(__dirname, 'early-access-shared.json');

function loadShared() {
  try { return new Set(JSON.parse(fs.readFileSync(SHARED_LOG, 'utf8'))); }
  catch { return new Set(); }
}
function saveShared(set) {
  fs.writeFileSync(SHARED_LOG, JSON.stringify([...set], null, 2));
}

// ---------- Salary parsing ----------
// Naukri shows salary as "5-9 Lacs PA", "₹ 5.5-9 Lacs P.A.", "5-9 LPA", or as
// raw rupee amounts like "5,00,000 - 9,50,000 PA". "Not disclosed" (or any
// unparseable text) returns null — which the rule treats as "share interest".
export function parseSalaryRange(text) {
  if (!text) return null;
  const t = text.replace(/₹/g, '').replace(/\s+/g, ' ');

  let m = t.match(/(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*(?:lacs?|lakhs?|lpa)/i);
  if (m) return { min: +m[1], max: +m[2] };

  m = t.match(/(\d[\d,]{3,})\s*-\s*(\d[\d,]{3,})\s*(?:pa\b|p\.a|per annum)/i);
  if (m) {
    const min = parseInt(m[1].replace(/,/g, ''), 10) / 100000;
    const max = parseInt(m[2].replace(/,/g, ''), 10) / 100000;
    if (min > 0 && max > 0) return { min, max };
  }
  return null;
}

export function salaryQualifies(range) {
  if (!range) return true; // range not provided -> share interest
  return range.min >= cfg.eaMinSalaryLower || range.max >= cfg.eaMinSalaryUpper;
}

// ---------- Find the Early access roles list ----------
// The section lives as a widget on the logged-in homepage (with a "View all"
// link) and as a tab/section on the recommended-jobs page. Naukri's class names
// here are minified and churn, so we anchor on the visible text instead.
// Returns the Page holding the list ("View all" may open a new tab), or null.
async function openEarlyAccessList(page) {
  // Strategy 1: recommended-jobs page, "Early access" tab.
  try {
    await page.goto('https://www.naukri.com/mnjuser/recommendedjobs', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await jitter(2000, 3500);
    const tab = page
      .locator('a, button, li, [role="tab"], [class*="tab" i] div')
      .filter({ hasText: /early\s*access/i })
      .first();
    if (await tab.count()) {
      await tab.click({ timeout: 5000 });
      await jitter(2000, 3000);
      log('   opened Early access tab on recommended-jobs page');
      return page;
    }
  } catch (e) {
    log('   recommended-jobs page failed:', e.message.slice(0, 120));
  }

  // Strategy 2: homepage widget — click its "View all" link, or use the widget in place.
  try {
    await page.goto('https://www.naukri.com/mnjuser/homepage', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await jitter(2000, 3500);
    const heading = page.getByText(/early\s*access\s*roles?/i).first();
    if (await heading.count()) {
      // "View all" that belongs to this widget = nearest common ancestor that
      // holds both the heading and a view-all link.
      const widget = heading.locator('xpath=ancestor::*[.//a[contains(translate(text(),"VIEWAL","viewal"),"view all")]][1]');
      const viewAll = widget.locator('a').filter({ hasText: /view all/i }).first();
      if (await viewAll.count()) {
        // "View all" sometimes opens in a new tab — if it does, work there.
        const popupPromise = page.context().waitForEvent('page', { timeout: 5000 }).catch(() => null);
        await viewAll.click({ timeout: 5000 });
        const popup = await popupPromise;
        const target = popup || page;
        await target.waitForLoadState('domcontentloaded').catch(() => {});
        await jitter(2000, 3000);
        log(`   opened Early access roles via homepage "View all"${popup ? ' (new tab)' : ''}`);
        return target;
      }
      log('   no "View all" link — using the homepage widget cards in place');
      return page;
    }
  } catch (e) {
    log('   homepage widget lookup failed:', e.message.slice(0, 120));
  }
  return null;
}

// ---------- Collect early-access cards ----------
const SHARE_BTN_SELECTOR =
  'button:has-text("Share interest"), button:has-text("Show interest"), a:has-text("Share interest")';

// Toast texts that confirm a share went through. Checked one at a time —
// Playwright cannot mix text=/regex/ engines in a comma-separated list.
const SUCCESS_TOAST_SELECTORS = [
  'text=/interest (shared|sent)/i',
  'text=/shared successfully/i',
];

async function scrollList(page) {
  for (let i = 0; i < 5; i++) {
    await page.mouse.wheel(0, 1200);
    await jitter(400, 800);
  }
}

// Anchors on the "Share interest" button (the one stable, meaningful piece of
// text on these cards) and walks up to the enclosing card for title/salary.
// Must be re-run after every click: sharing removes that card's button, which
// shifts the indices the other button locators are pinned to.
async function collectCards(page) {
  const buttons = await page.locator(SHARE_BTN_SELECTOR).all();

  const seen = new Set();
  const cards = [];
  for (const btn of buttons) {
    // Card boundary: climb from the button until the next parent up would
    // contain a SECOND share-interest button — that parent is the list, the
    // current node is exactly one card. Class-name-independent, so it survives
    // Naukri's minified/churning class names.
    const info = await btn.evaluate((el) => {
      const isInterestBtn = (b) => /^\s*(share|show)\s+interest\s*$/i.test((b.textContent || '').trim());
      let card = el;
      while (card.parentElement && card.parentElement.tagName !== 'BODY') {
        const parent = card.parentElement;
        const matches = Array.from(parent.querySelectorAll('button, a')).filter(isInterestBtn);
        if (matches.length > 1) break;
        card = parent;
      }
      const link = card.querySelector('a[href*="/job-listings-"]');
      const titleEl = card.querySelector('h1, h2, h3, h4, a[href*="/job-listings-"], [class*="title" i]');
      return {
        text: (card.innerText || '').trim(),
        title: titleEl ? (titleEl.textContent || '').trim() : '',
        href: link ? link.getAttribute('href') : null,
      };
    }).catch(() => null);
    if (!info || !info.text) continue;

    // Card text is line-separated (title first) — use line 1 as the title
    // fallback when no heading/link element was found.
    const title = info.title || (info.text.split('\n')[0] || '').trim();

    // Stable id: the numeric job id from the link when present, otherwise the
    // normalized title+card text (early-access cards don't always link out).
    // "6h ago"/"1d ago" tokens are stripped — they change daily and would make
    // the same role look new on every run.
    const idMatch = info.href ? info.href.match(/-(\d{8,})(?:[/?#]|$)/) : null;
    const idText = info.text.replace(/\b\d+\s*[hdw]\s*ago\b/gi, '').slice(0, 120);
    const id = idMatch
      ? idMatch[1]
      : (title + '|' + idText).toLowerCase().replace(/[^a-z0-9|]+/g, '-');
    if (seen.has(id)) continue;
    seen.add(id);

    cards.push({ id, title: title || '(untitled role)', cardText: info.text, btn });
  }
  return cards;
}

// ---------- Share interest on one card ----------
async function shareInterest(page, card) {
  const btnCountBefore = await page.locator(SHARE_BTN_SELECTOR).count();

  await card.btn.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
  await jitter(400, 800);
  await card.btn.click({ timeout: 8000 });
  await jitter(1500, 2500);

  // Some flows pop a confirmation dialog — confirm it if one appears.
  const confirmBtn = page.locator(
    '[class*="modal" i] button:has-text("Share interest"), ' +
    '[class*="modal" i] button:has-text("Confirm"), ' +
    '[role="dialog"] button:has-text("Share interest"), ' +
    '[role="dialog"] button:has-text("Confirm"), ' +
    '[role="dialog"] button:has-text("Yes")'
  ).first();
  if (await confirmBtn.count()) {
    await confirmBtn.click({ timeout: 5000 }).catch(() => {});
    await jitter(1200, 2000);
  }

  // Success = a confirmation toast, or this card's Share-interest button
  // disappearing (page-wide share-button count dropped).
  for (const sel of SUCCESS_TOAST_SELECTORS) {
    if (await page.locator(sel).first().count()) return true;
  }
  const btnCountNow = await page.locator(SHARE_BTN_SELECTOR).count();
  return btnCountNow < btnCountBefore;
}

// ---------- Early-access run ----------
export async function runEarlyAccess(context, page) {
  log('\n⭐ Early access roles — share interest');
  log(`   rule: salary lower bound >= ${cfg.eaMinSalaryLower} LPA OR upper bound >= ${cfg.eaMinSalaryUpper} LPA, or no salary range shown`);
  log(`   dry-run: ${cfg.dryRun}`);

  const shared = loadShared();
  log(`   interest already shared in past runs: ${shared.size}`);

  const stats = { shared: 0, would: 0, skippedSalary: 0, alreadyShared: 0, unknown: 0, errors: 0, seen: 0 };

  const listPage = await openEarlyAccessList(page);
  if (!listPage) {
    log('⚠️  Could not find the Early access roles section — skipping.');
    await screenshot(page, 'early-access-not-found');
    return stats;
  }

  await scrollList(listPage);
  let cards = await collectCards(listPage);
  log(`   found ${cards.length} early-access card(s) with a Share-interest button`);
  if (!cards.length) await screenshot(listPage, 'early-access-no-cards');

  const processed = new Set();
  while (true) {
    const card = cards.find(c => !processed.has(c.id));
    if (!card) break;
    processed.add(card.id);

    if (stats.shared >= cfg.eaMaxInterests) {
      log(`   reached EARLY_ACCESS_MAX_INTERESTS (${cfg.eaMaxInterests}) — stopping.`);
      break;
    }
    stats.seen++;
    if (shared.has(card.id)) { stats.alreadyShared++; continue; }

    const range = parseSalaryRange(card.cardText);
    const rangeLabel = range ? `${range.min}-${range.max} LPA` : 'not disclosed';

    if (!salaryQualifies(range)) {
      stats.skippedSalary++;
      log(`   ⏭️  salary ${rangeLabel} outside rule, skipping: "${card.title}"`);
      continue;
    }

    if (cfg.dryRun) {
      stats.would++;
      log(`   📝 would share interest (salary ${rangeLabel}): "${card.title}"`);
      // In-memory only — a dry run must NOT persist ids, or the next real run
      // would skip everything the dry run merely previewed.
      shared.add(card.id);
      continue;
    }

    try {
      const ok = await shareInterest(listPage, card);
      if (ok) {
        stats.shared++;
        log(`   ✅ interest shared (salary ${rangeLabel}): "${card.title}"`);
      } else {
        // Clicked but no confirmation seen — count separately, still remember
        // the card so we don't hammer the same button every day.
        stats.unknown++;
        log(`   ❓ clicked but no confirmation (salary ${rangeLabel}): "${card.title}"`);
        await screenshot(listPage, `early-access-unknown-${stats.seen}`);
      }
      shared.add(card.id);
      saveShared(shared);
    } catch (e) {
      stats.errors++;
      log(`   ❌ error on "${card.title}": ${e.message.slice(0, 150)}`);
      await screenshot(listPage, `early-access-error-${stats.seen}`);
    }
    await jitter(2500, 4500);
    // The click re-rendered the list and shifted locator indices — re-scan so
    // the next card's button handle is valid. (Skips and dry-run don't touch
    // the DOM, so their `continue` paths above reuse the existing scan.)
    cards = await collectCards(listPage);
  }

  log('\n📊 Early access summary');
  log(`   ✅ interest shared: ${stats.shared}`);
  if (cfg.dryRun) log(`   📝 would share:     ${stats.would}`);
  log(`   ☑️ already shared:  ${stats.alreadyShared}`);
  log(`   ⏭️ salary skipped:  ${stats.skippedSalary}`);
  log(`   ❓ unconfirmed:     ${stats.unknown}`);
  log(`   ❌ errors:          ${stats.errors}`);
  log(`   👀 total seen:      ${stats.seen}`);
  return stats;
}

// ---------- Standalone entry point ----------
if (isMainModule(import.meta.url)) {
  (async () => {
    requireCreds();
    const { browser, context } = await launchContext();
    try {
      const page = await ensureLoggedIn(context);
      await runEarlyAccess(context, page);
      await context.storageState({ path: STORAGE_STATE });
    } finally {
      await browser.close();
    }
  })().catch(err => {
    console.error('FATAL', err);
    process.exit(1);
  });
}
