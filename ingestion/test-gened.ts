import { chromium } from 'playwright';

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  page.on('response', async res => {
    const url = res.url();
    if (url.includes('coursedog.com') && url.includes('api')) {
      console.log('API Call:', url);
    }
  });

  await page.goto('https://catalog.ramapo.edu/general-education');
  await page.waitForTimeout(3000);
  await browser.close();
}
main();
