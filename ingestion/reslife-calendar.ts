import path from 'path';
import fs from 'fs';
import { chromium } from 'playwright';

async function fetchReslifeCalendar() {
    console.log('Launching browser to fetch Residence Life important dates...');
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await browser.newPage();
        await page.goto('https://www.ramapo.edu/reslife/critical-housing-dates-deadlines-calendar/', { waitUntil: 'networkidle' });
        
        const reslifeDates = await page.evaluate(() => {
            // Grab all visible text on the page
            return document.body.innerText.replace(/\n\s*\n/g, '\n').trim();
        });
        
        if (reslifeDates) {
            // Find the boundary where the real dates begin and end
            const startMatch = reslifeDates.match(/(Fall|Spring|Summer|Winter)\s+\d{4}:/i);
            const startIndex = startMatch && startMatch.index !== undefined ? startMatch.index : -1;
            const endIndex = reslifeDates.indexOf("505 Ramapo Valley Road");
            
            if (startIndex === -1 || endIndex === -1) {
                console.error('Could not find expected start/end markers in text');
                return;
            }
            
            const relevantText = reslifeDates.substring(startIndex, endIndex).trim();
            const lines = relevantText.split('\n').filter(line => line.trim() !== '');
            
            const semesters: { name: string, events: any[] }[] = [];
            let currentSemester: { name: string, events: any[] } | null = null;
            let currentCategory = "";
            let currentEvent: any = null;
            
            // Helpful regexes
            const semesterRegex = /^(Fall|Spring|Summer|Winter)\s+\d{4}:$/i;
            const categoryRegex = /^(Move-In Dates:|Refund Deadlines:|Move-Out Information:|Move-In:|Important Housing Deadline:)$/i;
            const singleDateRegex = /^([a-zA-Z]+) (\d+), (\d{4}):$/i;
            
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i].trim();
                
                // 1. Check for Semester Boundary (e.g. "Fall 2025:")
                if (semesterRegex.test(line)) {
                    if (currentSemester) semesters.push(currentSemester);
                    currentSemester = {
                        name: line.replace(':', ''),
                        events: []
                    };
                    currentCategory = "";
                    currentEvent = null;
                    continue;
                }
                
                if (!currentSemester) continue;
                
                // 2. Check for Category (e.g. "Move-In Dates:")
                if (categoryRegex.test(line)) {
                    currentCategory = line.replace(':', '');
                    currentEvent = null;
                    continue;
                }
                
                // 3. Parse specific date blocks
                
                // A. Specific Date Header (e.g. "September 2, 2025:")
                const dateMatch = line.match(singleDateRegex);
                if (dateMatch) {
                    const month = dateMatch[1].substring(0, 3); // "Sep"
                    const day = dateMatch[2].padStart(2, '0'); // "02"
                    
                    // We found a new date header, wait for bullets underneath it
                    currentEvent = {
                        date: `${month}. ${day}`,
                        title: `${currentCategory}`,
                        description: ""
                    };
                    
                    // If it's the refund deadline specifically, we'll collect the bullets into description/title combo
                    if (currentCategory.includes("Refund")) {
                         currentEvent.title = "Refund Deadline";
                    }
                    
                    currentSemester.events.push(currentEvent);
                    continue;
                }
                
                // B. Bullet points (Refund details)
                if (line.startsWith('–') || line.startsWith('-')) {
                    if (currentEvent) {
                        const detail = line.substring(1).trim();
                        if (currentEvent.description) {
                            currentEvent.description += `\n• ${detail}`;
                        } else {
                            currentEvent.description = `• ${detail}`;
                        }
                    }
                    continue;
                }
                
                // C. Move-In/Move-Out Paragraphs (e.g. "First-Year and New Transfer Students: Residence halls open...")
                // These don't always have a strict "Date:" header first, the date is buried in the text.
                if (currentCategory.includes("Move-In") || currentCategory.includes("Move-Out") || currentCategory.includes("Important Housing Deadline")) {
                    
                    // Try to guess a date from the text like "August 24, 2025"
                    const embeddedDateMatch = line.match(/([A-Z][a-z]+)\s+(\d{1,2}),\s+(\d{4})/);
                    let displayDate = "TBA";
                    if (embeddedDateMatch) {
                        const month = embeddedDateMatch[1].substring(0, 3);
                        const day = embeddedDateMatch[2].padStart(2, '0');
                        displayDate = `${month}. ${day}`;
                    }
                    
                    // Extract a smart title if it leads with a colon, but avoid splitting on times like "6:00 PM"
                    let title = currentCategory;
                    let desc = line;
                    
                    if (line.includes(':')) {
                        const parts = line.split(':');
                        if (parts[0].length < 40) {
                            title = parts[0].trim();
                            desc = parts.slice(1).join(':').trim();
                        }
                    }
                    
                    currentSemester.events.push({
                        date: displayDate,
                        title: title,
                        description: desc
                    });
                }
            }
            
            if (currentSemester) semesters.push(currentSemester);
            
            const outPath = path.join(process.cwd(), 'data', 'normalized', 'reslife.json');
            fs.writeFileSync(outPath, JSON.stringify(semesters, null, 2));
            console.log(`Saved structured ResLife calendar to ${outPath}`);
            console.log(JSON.stringify(semesters, null, 2));
        }
    } catch (e) {
        console.error('Failed to scrape ResLife:', e);
    } finally {
        await browser.close();
    }
}

fetchReslifeCalendar();
