import { chromium } from 'playwright';

async function test() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  
  console.log('Visiting Archway login...');
  await page.goto('https://archway.ramapo.edu/login_only', { waitUntil: 'domcontentloaded' });
  
  try {
    const loginBtn = await page.waitForSelector('a.btn--school', { timeout: 5000 });
    if (loginBtn) {
      await loginBtn.click();
      await page.waitForTimeout(3000);
    }
  } catch {
    console.log('No SSO button, already there...');
  }
  
  await page.screenshot({ path: 'core/scripts/fetch/test-sso.png' });
  console.log('Took screenshot as core/scripts/fetch/test-sso.png');
  
  const inputs = await page.locator('input').all();
  for (const input of inputs) {
    const id = await input.getAttribute('id');
    const name = await input.getAttribute('name');
    const type = await input.getAttribute('type');
    console.log(`Input: [id=${id}] [name=${name}] [type=${type}]`);
  }
  
  await browser.close();
}
test();
