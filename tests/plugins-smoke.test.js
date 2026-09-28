import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { test, expect, _electron as electron } from '@playwright/test';

const appPath = path.resolve(import.meta.dirname, '..');

// The plugins enabled in the beta build's reference setup.
const PLUGINS = [
  'precise-volume',
  'ambient-mode',
  'exponential-volume',
  'synced-lyrics',
  'quality-changer',
  'smooth-transitions',
  'seek-shortcuts',
  'fullscreen-auto-hide',
  'snappy',
];

test('Beta build - app launches with the beta plugins enabled and no renderer errors', async () => {
  test.setTimeout(120_000);
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'pear-smoke-'));
  fs.writeFileSync(
    path.join(userData, 'config.json'),
    JSON.stringify({
      plugins: Object.fromEntries(PLUGINS.map((id) => [id, { enabled: true }])),
    }),
  );

  const app = await electron.launch({
    cwd: appPath,
    // Not NODE_ENV=test: that turns on the renderer sandbox, where the
    // preload script can't load and no plugins run at all - launch the way
    // the packaged app does instead.
    env: { ...process.env, NODE_ENV: 'production' },
    args: [
      appPath,
      `--user-data-dir=${userData}`,
      '--no-sandbox',
      '--disable-gpu',
      '--whitelisted-ips=',
      '--disable-dev-shm-usage',
    ],
  });

  const window = await app.firstWindow();
  const errors = [];
  window.on('pageerror', (error) => {
    // Only errors thrown from the app's own renderer bundle - the site's own
    // scripts are out of our hands.
    if (String(error.stack).includes('youtube-music.iife.js')) {
      errors.push(error.stack);
    }
  });

  // Outside the US the site first shows a cookie consent page; decline it.
  await window.waitForURL(/^https:\/\/(consent|music)\./, { timeout: 60_000 });
  if (window.url().includes('consent.')) {
    await window
      .getByRole('button', { name: /reject all/i })
      .first()
      .click();
  }

  await window.waitForURL(/^https:\/\/music\./, { timeout: 60_000 });
  await window.waitForSelector('ytmusic-app', {
    state: 'attached',
    timeout: 60_000,
  });
  // Give plugins time to start and hook into the player.
  await window.waitForTimeout(15_000);

  // Snappy wraps fetch when its preload option is on.
  const fetchPatched = await window.evaluate(
    () => !window.fetch.toString().includes('[native code]'),
  );
  expect(fetchPatched).toBe(true);
  expect(errors).toEqual([]);

  await app.close();
  fs.rmSync(userData, { recursive: true, force: true });
});
