import { chromium } from 'playwright';

async function fetchReslifeCalendar() {
    console.log('Launching browser to fetch Residence Life calendar...');
    
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    
    try {
        await page.goto('https://www.ramapo.edu/reslife/important-dates/', { waitUntil: 'networkidle' });
        
        // Dump the whole element to trace how it represents dates visually and log it
        const reslifeDates = await page.evaluate(() => {
            const container = document.querySelector('.entry-content');
            return container ? container.innerHTML : 'No content found';
        });
        
        console.log("Raw HTML extracted from .entry-content:\n", reslifeDates.substring(0, 500));
        
    } catch (error: unknown) {
        console.error('Error fetching calendar:', error);
    } finally {
        await browser.close();
    }
}

fetchReslifeCalendar();
