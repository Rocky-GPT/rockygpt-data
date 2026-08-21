import assert from 'node:assert/strict';
import { chromium, type Browser, type Page } from 'playwright';

type ExpectedMode = 'enforce' | 'report-only';

interface CspViolation {
  blockedUri: string;
  directive: string;
  documentUri: string;
}

function parseArguments(): { baseUrl: string; mode: ExpectedMode } {
  const positional = process.argv.slice(2).filter((argument) => !argument.startsWith('--'));
  const modeArgument = process.argv.find((argument) => argument.startsWith('--mode='));
  const mode = modeArgument?.slice('--mode='.length) ?? 'enforce';
  assert.ok(mode === 'enforce' || mode === 'report-only', '--mode must be enforce or report-only.');

  const rawUrl = positional[0] ?? process.env.SECURITY_HEADERS_BASE_URL ?? 'http://localhost:3000';
  const parsed = new URL(rawUrl);
  assert.match(parsed.protocol, /^https?:$/, 'The target must use HTTP or HTTPS.');
  parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  parsed.search = '';
  parsed.hash = '';
  return { baseUrl: parsed.toString().replace(/\/$/, ''), mode };
}

function assertResponseHeaders(response: Response, mode: ExpectedMode): void {
  assert.equal(response.headers.get('x-powered-by'), null, 'X-Powered-By must be absent.');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.match(response.headers.get('permissions-policy') ?? '', /camera=\(\)/);

  const expectedName = mode === 'enforce'
    ? 'content-security-policy'
    : 'content-security-policy-report-only';
  const otherName = mode === 'enforce'
    ? 'content-security-policy-report-only'
    : 'content-security-policy';
  const csp = response.headers.get(expectedName);
  assert.ok(csp, `${expectedName} must be present.`);
  assert.equal(response.headers.get(otherName), null, `${otherName} must be absent.`);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /object-src 'none'/);
}

async function installViolationRecorder(page: Page, violations: CspViolation[]): Promise<void> {
  await page.exposeFunction('__rockyRecordCspViolation', (violation: CspViolation) => {
    violations.push(violation);
  });
  await page.addInitScript(() => {
    if (window.top !== window) return;
    window.addEventListener('securitypolicyviolation', (event) => {
      const recorder = (window as typeof window & {
        __rockyRecordCspViolation: (violation: CspViolation) => Promise<void>;
      }).__rockyRecordCspViolation;
      void recorder({
        blockedUri: event.blockedURI,
        directive: event.effectiveDirective,
        documentUri: event.documentURI,
      });
    });
  });
}

async function exerciseHomePage(page: Page): Promise<void> {
  const flows = [
    { button: 'Birch Menu', dialog: 'Birch Tree Inn menu' },
    { button: 'Student Orgs', dialog: 'Student organizations' },
    { button: 'Campus Map', dialog: 'Campus map' },
  ];

  for (const flow of flows) {
    await page.getByRole('button', { name: flow.button, exact: true }).first().click();
    const dialog = page.getByRole('dialog', { name: flow.dialog });
    await dialog.waitFor({ state: 'visible', timeout: 10_000 });
    await page.waitForTimeout(750);
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden', timeout: 10_000 });
  }
}

async function launchBrowser(): Promise<Browser> {
  try {
    return await chromium.launch({ headless: true });
  } catch (error) {
    // Developer machines often have Chrome but not Playwright's optional browser download.
    if (!(error instanceof Error) || !error.message.includes("Executable doesn't exist")) throw error;
    return chromium.launch({ channel: 'chrome', headless: true });
  }
}

async function main(): Promise<void> {
  const { baseUrl, mode } = parseArguments();
  const response = await fetch(`${baseUrl}/`, {
    redirect: 'follow',
    signal: AbortSignal.timeout(15_000),
  });
  assert.ok(response.ok, `GET / returned HTTP ${response.status}.`);
  assertResponseHeaders(response, mode);

  const browser = await launchBrowser();
  const violations: CspViolation[] = [];
  try {
    const page = await browser.newPage();
    await installViolationRecorder(page, violations);
    for (const path of ['/', '/privacy']) {
      const navigation = await page.goto(`${baseUrl}${path}`, {
        waitUntil: 'networkidle',
        timeout: 30_000,
      });
      assert.ok(navigation?.ok(), `${path} failed to load.`);
      assert.ok(await page.locator('body').isVisible(), `${path} did not render a visible body.`);
      if (path === '/') await exerciseHomePage(page);
    }
  } finally {
    await browser.close();
  }

  assert.deepEqual(
    violations,
    [],
    `Observed CSP violations:\n${JSON.stringify(violations, null, 2)}`
  );
  console.log(`Security headers and CSP browser check passed for ${baseUrl} (${mode}).`);
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
