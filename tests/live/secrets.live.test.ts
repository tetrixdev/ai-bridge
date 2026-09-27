/**
 * The whole vertical, against a running Engram and a real browser.
 *
 * Skipped unless ENGRAM_URL is set, so `npm test` is unaffected. It needs a
 * deployment, an account and Playwright:
 *
 *   ENGRAM_URL=https://engram.example.com NODE_TLS_REJECT_UNAUTHORIZED=0 \
 *   ENGRAM_TOKEN=eng_... ENGRAM_EMAIL=... ENGRAM_PASSWORD=... \
 *   npx vitest run tests/live
 *
 * What it proves, which nothing smaller can: that a secret sealed in a browser
 * is opened on this machine by a device key, reaches a tool as an environment
 * variable, and is redacted out of what the model gets back. Every piece of
 * that has a unit test and the seams between them do not.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { enrol, fillRoles, loadSecrets } from '../../src/local/engram.js';
import { runLocalTool } from '../../src/local/executor.js';
import { loadOrCreateIdentity, saveIdentity } from '../../src/local/identity.js';

const BASE = process.env['ENGRAM_URL']!;
const TOKEN = process.env['ENGRAM_TOKEN']!;
const EMAIL = process.env['ENGRAM_EMAIL']!;
const PASSWORD = process.env['ENGRAM_PASSWORD']!;
const SECRET = 'live-vertical-7b31fe';

describe.skipIf(!process.env['ENGRAM_URL'])('a secret from a browser vault reaching a local tool', () => {
  it('is decrypted here, used by the tool, and redacted on the way back', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'engram-live-'));
    const identityPath = join(dir, 'device.json');

    // 1. The device makes a keypair and enrols. enrol() re-derives the
    //    fingerprint from the key it sent and refuses if Engram reports one for
    //    a different key, so a substitution fails here rather than being
    //    approved by a person reading a value the server chose.
    const identity = await loadOrCreateIdentity(identityPath);
    const cfg = { baseUrl: BASE, token: TOKEN };
    const { deviceId, fingerprint } = await enrol(cfg, identity, 'Live test bridge', 'transcript');
    identity.deviceId = deviceId;
    await saveIdentity(identityPath, identity);

    // 2. Before a human approves, it holds nothing.
    expect((await loadSecrets(cfg, identity, deviceId)).size).toBe(0);

    // 3. A person does the browser half: vault, secret, approve, grant.
    writeFileSync(join(dir, 'approve.spec.js'), browserHalf(BASE, deviceId, SECRET));
    writeFileSync(join(dir, '.creds'), `${EMAIL}\n${PASSWORD}\n`);
    execFileSync(
      `${process.env['HOME']}/.local/bin/pw`,
      ['--host', `${new URL(BASE).hostname}=proxy-nginx`, 'test', 'approve.spec.js'],
      { cwd: dir, stdio: 'inherit' },
    );

    // 4. The device opens what was wrapped for it, and fills a role with it
    //    the way a local_call names it: item, field, sealed-value id, space.
    const available = await loadSecrets(cfg, identity, deviceId);
    const listed = await (await fetch(new URL(`/devices/${deviceId}/secrets`, BASE), {
      headers: { authorization: `Bearer ${TOKEN}` },
    })).json() as { secrets: { id: string; space_id: string; item_id: string; field: string }[] };
    const row = listed.secrets.find((r) => r.field === 'deploy_key')!;
    const filled = fillRoles(available, [{
      role: 'deploy', item_id: row.item_id, space_id: row.space_id,
      sealed: [{ field: 'deploy_key', secret_id: row.id, space_id: row.space_id }],
    }]);
    const granted = filled.sealed;
    expect(granted).toHaveLength(1);
    expect(granted[0]!.name).toBe('ENGRAM_DEPLOY_DEPLOY_KEY');
    // The same value, claimed through a space that did not seal it, is refused
    // rather than served: the boundary is the space, not the id.
    expect(() => fillRoles(available, [{
      role: 'deploy', item_id: row.item_id, space_id: 'another-space',
      sealed: [{ field: 'deploy_key', secret_id: row.id, space_id: 'a-space-this-device-does-not-hold' }],
    }])).toThrow();

    // 5. The tool sees the real value; the model does not. Both halves in one
    //    run, because either alone would pass while the other was broken.
    const result = await runLocalTool({
      name: 'check',
      command: 'sh',
      args: ['-c', '[ "$ENGRAM_DEPLOY_DEPLOY_KEY" = "$ENGRAM_ARG_EXPECTED" ] && echo MATCH; echo "value: $ENGRAM_DEPLOY_DEPLOY_KEY"'],
      toolArgs: { expected: SECRET },
      secrets: granted,
    });

    expect(result.stdout).toContain('MATCH');
    expect(result.stdout).toContain('[redacted: ENGRAM_DEPLOY_DEPLOY_KEY]');
    expect(result.stdout).not.toContain(SECRET);
  }, 120_000);
});

function browserHalf(base: string, deviceId: string, secret: string): string {
  return `
const { test, expect } = require('@playwright/test')
const fs = require('fs')
test.use({ ignoreHTTPSErrors: true })
const [EMAIL, PASSWORD] = fs.readFileSync(__dirname + '/.creds', 'utf8').trim().split('\\n')

test('approve the device and give it a key', async ({ page, context }) => {
  test.setTimeout(30_000)
  const cdp = await context.newCDPSession(page)
  await cdp.send('WebAuthn.enable')
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: {
    protocol: 'ctap2', ctap2Version: 'ctap2_1', transport: 'internal',
    hasResidentKey: true, hasUserVerification: true, isUserVerified: true,
    automaticPresenceSimulation: true, hasPrf: true } })

  await page.goto('${base}/login')
  await page.fill('input[type=email]', EMAIL)
  await page.fill('input[type=password]', PASSWORD)
  await page.locator('form button[type=submit]').first().click()
  await page.waitForURL(/\\/(dev\\/mcp|account|spaces)?$/, { timeout: 5000 })

  await page.evaluate(async () => {
    const { spaces } = await (await fetch('/spaces/list')).json()
    if (!spaces.some((s) => s.slug === 'livespace')) {
      await fetch('/spaces/create', { method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slug: 'livespace', name: 'Live Space' }) })
    }
  })

  await page.goto('${base}/account')
  await page.getByRole('button', { name: /Add a passkey/i }).click()
  await expect(page.locator('text=Passkey added.')).toBeVisible({ timeout: 5000 })

  await page.goto('${base}/vault')
  await page.locator('[data-testid=create-vault]').click()
  await expect(page.locator('[data-testid=recovery-code]')).toBeVisible({ timeout: 5000 })
  await page.locator('button:has-text("I have written it down")').click()

  await page.locator('[data-testid=item-name]').fill('Deploy')
  await page.locator('[data-testid=item-kind]').fill('github_deploy_key')
  await page.locator('[data-testid=item-sealed-field]').fill('deploy_key')
  await page.locator('[data-testid=item-sealed-value]').fill(${JSON.stringify(secret)})
  await page.locator('[data-testid=save-item]').click()
  await expect(page.locator('[data-testid="reveal-Deploy-deploy_key"]')).toBeVisible({ timeout: 5000 })

  await page.locator('[data-testid="approve-${deviceId}"]').click()
  await expect(page.locator('[data-testid="givekey-${deviceId}"]')).toBeVisible({ timeout: 5000 })
  await page.locator('[data-testid="givekey-${deviceId}"]').click()
  await expect(page.locator('text=can now use')).toBeVisible({ timeout: 5000 })
})
`;
}
