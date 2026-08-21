import { chromium } from 'playwright';

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto('https://catalog.ramapo.edu/general-education');
  
  const stateHandle = await page.evaluateHandle(() => (window as any).__INITIAL_STATE__);
  const state = await stateHandle.jsonValue();
  
  if (state && state.page && state.page.content) {
    console.log('Content structure:', state.page.content.substring(0, 500));
  } else {
    // try NEXT_DATA
    const nextDataHandle = await page.evaluateHandle(() => (window as any).__NEXT_DATA__);
    const nextData: any = await nextDataHandle.jsonValue();
    const content = nextData?.props?.pageProps?.page?.content || nextData?.props?.pageProps?.initialState?.page?.content;
    console.log('Content type:', typeof content, 'length:', content?.length);
    if (content) {
        // Find course codes
        const matches = [...content.matchAll(/([A-Z]{2,4}\s+\d{3,4})/g)];
        console.log('Found courses:', Array.from(new Set(matches.map(m => m[1]))).slice(0, 20));
    }
  }

  await browser.close();
}
main();
