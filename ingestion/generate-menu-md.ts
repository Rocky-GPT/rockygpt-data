import fs from 'fs';
import path from 'path';
import { buildFrontmatter } from './frontmatter';
import { getGeneratedTimestamp, sortByName } from './pipeline-utils';
import { type MenuSection, validateMenuData } from './schema';

interface ContextMenuItem {
  name: string;
  calories?: string;
  traits: string[];
  description?: string;
}

interface ContextMenuGroup {
  name?: string;
  items: ContextMenuItem[];
}

interface ContextMenuSection {
  name: string;
  groups: ContextMenuGroup[];
}

const DATA_DIR = path.join(process.cwd(), 'data', 'normalized');
const OUTPUT_DIR = path.join(process.cwd(), 'data', 'context', 'dining');
const JSON_INPUT_PATH = path.join(DATA_DIR, 'menu.json');
const MARKDOWN_OUTPUT_PATH = path.join(OUTPUT_DIR, 'menu.md');
const MAX_DESCRIPTION_LENGTH = 240;

function normalizeText(value?: string): string | undefined {
  if (!value) return undefined;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  return trimmed || undefined;
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 3).trimEnd()}...`;
}

function toContextMenu(menuData: MenuSection[]): ContextMenuSection[] {
  return sortByName(
    menuData
      .map((section): ContextMenuSection | null => {
        const sectionName = normalizeText(section.name);
        if (!sectionName || !Array.isArray(section.groups)) {
          return null;
        }

        const groups = sortByName(
          section.groups
            .map((group): ContextMenuGroup | null => {
              if (!Array.isArray(group.items)) return null;

              const items = sortByName(
                group.items
                  .map((item): ContextMenuItem | null => {
                    const name = normalizeText(item.formalName);
                    if (!name) return null;

                    const traits = new Set<string>();
                    if (Array.isArray(item.allergens)) {
                      item.allergens.forEach((allergen) => {
                        const allergenName = normalizeText(allergen?.name);
                        if (allergenName) traits.add(allergenName);
                      });
                    }
                    if (item.isVegan) traits.add('Vegan');
                    if (item.isVegetarian) traits.add('Vegetarian');
                    if (item.isMindful) traits.add('Mindful');
                    if (item.isPlantBased) traits.add('Plantbased');

                    const description = normalizeText(item.description);
                    return {
                      name,
                      calories: normalizeText(item.calories),
                      traits: Array.from(traits).sort((a, b) => a.localeCompare(b)),
                      description: description
                        ? truncate(description, MAX_DESCRIPTION_LENGTH)
                        : undefined,
                    };
                  })
                  .filter((item): item is ContextMenuItem => item !== null),
                (item) => item.name
              );

              if (items.length === 0) return null;
              return {
                name: normalizeText(group.name),
                items,
              };
            })
            .filter((group): group is ContextMenuGroup => group !== null),
          (group) => group.name || 'Uncategorized'
        );

        if (groups.length === 0) return null;
        return { name: sectionName, groups };
      })
      .filter((section): section is ContextMenuSection => section !== null),
    (section) => section.name
  );
}

function generateMarkdown() {
  if (!fs.existsSync(JSON_INPUT_PATH)) {
    console.error(`Error: Data file not found at ${JSON_INPUT_PATH}`);
    process.exit(1);
  }

  let menuData: MenuSection[];
  try {
    const rawData = JSON.parse(fs.readFileSync(JSON_INPUT_PATH, 'utf-8'));
    if (Array.isArray(rawData) && rawData.length === 0) {
      console.log('Menu JSON is an empty array. Writing placeholder menu with frontmatter.');
      const generatedAt = getGeneratedTimestamp();
      const frontmatter = buildFrontmatter({
        source_url: 'https://ramapo.sodexomyway.com/en-us/locations/birch-tree-inn',
        title: 'Dining Menus',
        trust_tier: 'official_primary',
        freshness_sla_hours: 24,
      });
      let markdown = frontmatter + '# Birch Tree Inn Menu\n\n';
      markdown += `*Generated (UTC): ${generatedAt}*\n\n*Menu is not currently available.*\n\n---\n\n`;
      if (!fs.existsSync(OUTPUT_DIR)) {
        fs.mkdirSync(OUTPUT_DIR, { recursive: true });
      }
      fs.writeFileSync(MARKDOWN_OUTPUT_PATH, markdown, 'utf-8');
      return;
    }
    menuData = validateMenuData(rawData);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error validating menu JSON: ${message}`);
    process.exit(1);
  }

  const contextMenu = toContextMenu(menuData);
  console.log(`Loaded ${menuData.length} menu sections from JSON.`);
  console.log(`Selected ${contextMenu.length} sections for context markdown.`);

  const generatedAt = getGeneratedTimestamp();

  const frontmatter = buildFrontmatter({
    source_url: "https://ramapo.sodexomyway.com/en-us/locations/birch-tree-inn",
    title: "Dining Menus",
    trust_tier: "official_primary",
    freshness_sla_hours: 24
  });

  let markdown = frontmatter + '# Birch Tree Inn Menu\n\n';
  markdown += `*Generated (UTC): ${generatedAt}*\n\n`;
  markdown += '---\n\n';

  contextMenu.forEach((section) => {
    markdown += `## ${section.name}\n\n`;
    section.groups.forEach((group) => {
      if (group.name) {
        markdown += `### ${group.name}\n\n`;
      }
      group.items.forEach((item) => {
        let itemLine = `- **${item.name}**`;
        if (item.calories) {
          itemLine += ` (${item.calories} cal)`;
        }
        if (item.traits.length > 0) {
          itemLine += ` _[${item.traits.join(', ')}]_`;
        }
        markdown += `${itemLine}\n`;
        if (item.description) {
          markdown += `  > ${item.description}\n`;
        }
      });
      markdown += '\n';
    });
    markdown += '---\n\n';
  });

  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }
  fs.writeFileSync(MARKDOWN_OUTPUT_PATH, markdown, 'utf-8');
  console.log(`Successfully generated markdown at ${MARKDOWN_OUTPUT_PATH}`);
}

generateMarkdown();
