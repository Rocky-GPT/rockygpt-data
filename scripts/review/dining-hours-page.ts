/**
 * Describes Sodexo's dining hours page as a browser renders it right now: every "More hours"
 * button, whether it can be clicked, what hides it when it cannot, and each venue's block.
 * One page load; for finding out why the dining hours reader could not open a venue's hours.
 *
 *   npx tsx scripts/review/dining-hours-page.ts
 */
import { chromium } from 'playwright';

const URL = 'https://ramapo.sodexomyway.com/en-us/locations/hours';

async function main(): Promise<void> {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    // tsx wraps named functions in __name(), which a page does not have.
    await page.addInitScript({ content: 'window.__name = (fn) => fn;' });
    const started = Date.now();
    await page.goto(URL, { waitUntil: 'networkidle' });
    console.log(`Rendered ${URL} at ${new Date().toISOString()}; title "${await page.title()}"; viewport ${JSON.stringify(page.viewportSize())}.`);

    const buttons = page.locator('.more-hours');
    /** What is on the page at this moment, without clicking anything. */
    const sample = async (label: string) => {
      const count = await buttons.count();
      let seen = 0;
      for (let index = 0; index < count; index++) if (await buttons.nth(index).isVisible()) seen++;
      const venues = await page.locator('h2.location-name').count();
      const groups = await page.locator('.hours-detail-container').count();
      const regular = await page.locator('h3', { hasText: 'Regular Hours' }).count();
      console.log(`${label} (${((Date.now() - started) / 1000).toFixed(1)} s after the load began): ${count} "More hours" button(s), ${seen} visible; `
        + `${venues} venue heading(s); ${regular} "Regular Hours" heading(s); ${groups} day group(s) in the page.`);
    };
    await sample('At network idle');
    for (const wait of [500, 1000, 2000, 4000]) { await page.waitForTimeout(wait); await sample(`After ${wait} ms more`); }
    const count = await buttons.count();
    const visible: boolean[] = [];
    for (let index = 0; index < count; index++) visible.push(await buttons.nth(index).isVisible());

    const described = await page.evaluate(() => {
      const squash = (value: string | null | undefined) => (value ?? '').replace(/\s+/g, ' ').trim();
      const box = (element: Element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        const classes = [...element.classList].slice(0, 3).join('.');
        return `${element.tagName.toLowerCase()}${classes ? `.${classes}` : ''} [display ${style.display}, visibility ${style.visibility}, `
          + `${Math.round(rect.width)}x${Math.round(rect.height)}${element.hasAttribute('hidden') ? ', hidden attribute' : ''}`
          + `${element.getAttribute('aria-hidden') ? `, aria-hidden ${element.getAttribute('aria-hidden')}` : ''}]`;
      };
      const blockOf = (element: Element) => element.closest('[class*="Hoursstyles__LocationHoursContainer"]');
      const moreHours = [...document.querySelectorAll('.more-hours')].map((button) => {
        const chain: string[] = [];
        for (let element: Element | null = button; element && element !== document.body && chain.length < 12; element = element.parentElement) chain.push(box(element));
        const block = blockOf(button);
        return {
          venue: squash(block?.querySelector('h2.location-name')?.textContent) || '(no venue heading in its block)',
          text: squash(button.textContent), expanded: button.getAttribute('aria-expanded'), chain,
        };
      });
      const venues = [...document.querySelectorAll('h2.location-name')].map((heading) => {
        const block = blockOf(heading);
        const headings = [...(block?.querySelectorAll('h3') ?? [])].map((h3) => squash(h3.textContent));
        return {
          name: squash(heading.textContent), heading: box(heading), hasBlock: Boolean(block),
          moreHoursButtons: block?.querySelectorAll('.more-hours').length ?? 0,
          h3: headings, dayGroups: block?.querySelectorAll('.hours-detail-container').length ?? 0,
          text: squash(block?.textContent).slice(0, 260),
        };
      });
      const overlays = [...document.querySelectorAll('[role="dialog"], [aria-modal="true"], [id*="onetrust"], [class*="modal" i], [class*="cookie" i]')]
        .slice(0, 12).map((element) => `${box(element)} "${squash(element.textContent).slice(0, 80)}"`);
      return { moreHours, venues, overlays };
    });

    console.log('\n== Each "More hours" button (itself first, then what holds it) ==');
    described.moreHours.forEach((button, index) => {
      console.log(`\n#${index + 1} ${visible[index] ? 'VISIBLE' : 'NOT VISIBLE'}: venue "${button.venue}"; text "${button.text}"; aria-expanded ${button.expanded}`);
      for (const line of button.chain) console.log(`    ${line}`);
    });
    console.log('\n== Each venue heading and its block ==');
    for (const venue of described.venues) {
      console.log(`\n"${venue.name}": ${venue.heading}; block ${venue.hasBlock ? 'found' : 'NOT found'}; `
        + `${venue.moreHoursButtons} "More hours" button(s); h3: ${JSON.stringify(venue.h3)}; ${venue.dayGroups} day group(s)`);
      console.log(`    ${venue.text}`);
    }
    console.log(`\n== Dialogs, banners and the like: ${described.overlays.length} ==`);
    for (const overlay of described.overlays) console.log(`    ${overlay}`);

    console.log('\n== After clicking each visible "More hours" button ==');
    for (let index = 0; index < count; index++) {
      if (!visible[index]) continue;
      await buttons.nth(index).click({ timeout: 5000 }).catch((error: Error) => console.log(`    click #${index + 1} failed: ${error.message.split('\n')[0]}`));
    }
    await page.waitForTimeout(1000);
    await sample('After the clicks');
  } finally {
    await browser.close();
  }
}

main().catch((error) => { console.error(error instanceof Error ? error.stack ?? error.message : error); process.exitCode = 1; });
