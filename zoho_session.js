require('dotenv').config();
const puppeteer = require('puppeteer');
const http = require('http');

// Health check server for hosting platforms
const PORT = process.env.PORT || 8080;
http.createServer((req, res) => {
  res.writeHead(200);
  res.end('OK');
}).listen(PORT, () => console.log(`[Health] Server listening on port ${PORT}`));

const EMAIL = process.env.ZOHO_EMAIL;
const PASSWORD = process.env.ZOHO_PASSWORD;
const REFRESH_INTERVAL_MS = 1 * 60 * 1000; // 1 minute
const LOGIN_URL = 'https://accounts.zoho.com/signin?servicename=CRMPlus&signupurl=https://www.zoho.com/crm/crmplus/signup.html';
const TARGET_URL = 'https://crmplus.zoho.com';

async function login(page) {
  console.log('[Login] Navigating to Zoho sign-in page...');
  await page.goto(LOGIN_URL, { waitUntil: 'networkidle2', timeout: 60000 });

  // Handle email field
  try {
    await page.waitForSelector('#login_id', { timeout: 15000 });
    await page.type('#login_id', EMAIL, { delay: 80 });
    await page.click('#nextbtn');
    console.log('[Login] Email submitted.');
  } catch (e) {
    console.log('[Login] Email field not found, may already be on password step.');
  }

  // Handle password field — try multiple known button selectors
  await page.waitForSelector('#password', { timeout: 20000 });
  await page.type('#password', PASSWORD, { delay: 80 });

  const submitSelector = await page.evaluate(() => {
    const candidates = ['#signin_submit', '#nextbtn', 'button[type="submit"]', 'input[type="submit"]'];
    for (const sel of candidates) {
      if (document.querySelector(sel)) return sel;
    }
    return null;
  });

  if (!submitSelector) throw new Error('Could not find a submit button on the password page.');
  await page.click(submitSelector);
  console.log(`[Login] Password submitted via "${submitSelector}", waiting for session...`);
}

async function waitForSalesIQSession(page) {
  console.log('[Session] Waiting for SalesIQ to be ready...');

  // Wait until URL contains salesiq or dashboard loads (up to 90 seconds)
  await page.waitForFunction(
    () =>
      window.location.href.includes('salesiq') ||
      window.location.href.includes('dashboard') ||
      document.querySelector('.salesiq-header') !== null ||
      document.querySelector('[data-module="SalesIQ"]') !== null ||
      document.title.toLowerCase().includes('salesiq'),
    { timeout: 90000, polling: 2000 }
  ).catch(() => {
    // If specific check fails, just check we're past the login page
    console.log('[Session] Specific SalesIQ indicator not found, checking if login page is gone...');
  });

  const url = page.url();
  const title = await page.title();
  console.log(`[Session] Current URL: ${url}`);
  console.log(`[Session] Page title: ${title}`);

  if (url.includes('accounts.zoho.com') || url.includes('accounts.zoho.in') || url.includes('login')) {
    throw new Error('Still on login page — authentication may have failed.');
  }

  console.log('[Session] SalesIQ session is active!');
}

async function keepAlive(page, browser) {
  let refreshCount = 0;

  const doRefresh = async () => {
    refreshCount++;
    const timestamp = new Date().toLocaleString();
    console.log(`[Refresh #${refreshCount}] ${timestamp} — Refreshing page...`);

    try {
      const currentUrl = page.url();
      await page.reload({ waitUntil: 'networkidle2', timeout: 60000 });

      const newUrl = page.url();
      const title = await page.title();

      // Detect if we got redirected to login
      if (newUrl.includes('accounts.zoho.com') || newUrl.includes('accounts.zoho.in') || newUrl.includes('/login')) {
        console.log('[Session] Redirected to login page — re-authenticating...');
        await login(page);
        await waitForSalesIQSession(page);
      } else {
        console.log(`[Refresh #${refreshCount}] Done. Title: "${title}"`);
      }
    } catch (err) {
      console.error(`[Refresh #${refreshCount}] Error during refresh: ${err.message}`);
      // Try to recover
      try {
        await page.goto(TARGET_URL, { waitUntil: 'networkidle2', timeout: 60000 });
        const url = page.url();
        if (url.includes('accounts.zoho.com') || url.includes('accounts.zoho.in') || url.includes('/login')) {
          await login(page);
          await waitForSalesIQSession(page);
        }
      } catch (recoveryErr) {
        console.error('[Recovery] Recovery failed:', recoveryErr.message);
      }
    }
  };

  // Schedule refreshes every 30 minutes
  setInterval(doRefresh, REFRESH_INTERVAL_MS);
  console.log(`[KeepAlive] Refresh scheduled every ${REFRESH_INTERVAL_MS / 60000} minutes.`);

  // Keep the process alive
  process.on('SIGINT', async () => {
    console.log('\n[Exit] Shutting down gracefully...');
    await browser.close();
    process.exit(0);
  });

  // Prevent Node.js from exiting
  await new Promise(() => {}); // hang forever
}

async function main() {
  if (!EMAIL || !PASSWORD) {
    console.error('[Error] Set ZOHO_EMAIL and ZOHO_PASSWORD in .env file.');
    process.exit(1);
  }

  console.log('[Start] Launching Chromium...');
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-setuid-sandbox',
    ],
    ignoreDefaultArgs: ['--enable-automation'],
  });

  const [page] = await browser.pages();

  // Mask automation signals
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  try {
    await login(page);
    await waitForSalesIQSession(page);
    await keepAlive(page, browser);
  } catch (err) {
    console.error('[Fatal]', err.message);
    await browser.close();
    process.exit(1);
  }
}

main();
