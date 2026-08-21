
import fs from 'fs';
import path from 'path';
import { publicPath } from '../src/paths';

// Config
const MENU_PATH = path.join(process.cwd(), 'data', 'context', 'dining', 'menu.md');
const IMAGES_DIR = publicPath('images/menu');
const PLACEHOLDER_SRC = path.join(IMAGES_DIR, 'placeholder.jpg');

// Helpers
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, '') // Remove non-word chars
    .replace(/[\s_-]+/g, '-') // Replace spaces/underscores with -
    .replace(/^-+|-+$/g, ''); // Trim -
}

async function main() {
  console.log('🍽️  Generating placeholder images for menu items...');

  if (!fs.existsSync(MENU_PATH)) {
    console.error('❌ Menu file not found:', MENU_PATH);
    process.exit(1);
  }

  if (!fs.existsSync(PLACEHOLDER_SRC)) {
     console.error('❌ Placeholder image not found:', PLACEHOLDER_SRC);
     process.exit(1);
  }

  const menuContent = fs.readFileSync(MENU_PATH, 'utf-8');
  const lines = menuContent.split('\n');
  const items = new Set<string>();

  // Extract items
  // Format: - **Name** (cal) ...
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('- **')) {
       const match = trimmed.match(/\*\*(.*?)\*\*/);
       if (match && match[1]) {
           items.add(match[1]);
       }
    }
  }

  console.log(`Found ${items.size} unique menu items.`);

  // Generate files
  let createdCount = 0;
  for (const item of items) {
      const slug = slugify(item);
      const destPath = path.join(IMAGES_DIR, `${slug}.jpg`);

      if (!fs.existsSync(destPath)) {
          fs.copyFileSync(PLACEHOLDER_SRC, destPath);
          createdCount++;
      }
  }

  console.log(`✅ Generated ${createdCount} new placeholder images.`);
  console.log(`📂 Images located in: ${IMAGES_DIR}`);
}

main().catch(console.error);
