import assert from 'node:assert/strict';
import { join } from 'node:path';
import { editedHeading, originalHeading } from './fixture.mjs';

export async function poll(label, read, accepts, timeout = 120000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try { last = await read(); if (accepts(last)) return last; }
    catch (error) { last = error.message; }
    await Bun.sleep(100);
  }
  throw new Error(`Timed out: ${label}. Last observation: ${JSON.stringify(last)}`);
}

export async function exerciseEditor({ page, origin, evidence, timeout, checkpoint, restart, provider }) {
  const frame = () => page.frameLocator('iframe');
  const heading = () => frame().locator('main h1');
  const padding = () => page.getByLabel('Padding, all sides', { exact: true });
  const steps = () => page.getByRole('list', { name: 'Kept steps' }).locator(':scope > li');
  const wait = (label, read, accepts) => poll(label, read, accepts, timeout);
  const visibleText = async (locator, text) => wait(`displayed text ${text}`, () => locator.innerText(), value => value === text);
  const paddingIs = async value => wait(`computed padding ${value}px`, () => heading().evaluate(el => getComputedStyle(el).paddingTop), actual => actual === `${value}px`);
  const pending = () => page.getByRole('button', { name: 'Keep', exact: true }).waitFor({ state: 'visible' });
  const settled = () => page.getByRole('button', { name: 'Keep', exact: true }).waitFor({ state: 'hidden' });
  const selection = async () => {
    await page.getByRole('heading', { name: '<h1>', exact: true }).waitFor();
    await wait('displayed heading selection outline', () => heading().evaluate(el => {
      const overlay = document.querySelector('[data-neat-overlay]');
      if (!(overlay instanceof HTMLElement) || getComputedStyle(overlay).display === 'none') return false;
      const a = el.getBoundingClientRect(), b = overlay.getBoundingClientRect();
      return overlay.textContent.startsWith('h1 ') && ['left', 'top', 'width', 'height'].every(key => Math.abs(a[key] - b[key]) < 2);
    }), value => value === true);
  };
  const keep = async () => {
    await page.getByRole('button', { name: 'Keep', exact: true }).click();
    await settled();
    await wait('property controls ready', () => padding().isEnabled(), Boolean);
  };
  const undoPending = async () => {
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await settled();
    await wait('property controls ready after undo', () => padding().isEnabled(), Boolean);
  };
  const fullReload = async () => {
    const target = await page.locator('iframe').elementHandle();
    const child = await target.contentFrame();
    assert.ok(child, 'Preview frame is attached');
    const before = await child.evaluate(() => performance.timeOrigin);
    const readyBefore = await page.evaluate(() => window.__neatAcceptanceReadyCount ?? 0);
    await child.goto(child.url(), { waitUntil: 'domcontentloaded' });
    await heading().waitFor();
    const after = await child.evaluate(() => performance.timeOrigin);
    assert.notEqual(after, before, 'A fresh preview document was loaded');
    await wait('native preview ready after full navigation', () => page.evaluate(() => window.__neatAcceptanceReadyCount ?? 0), count => count > readyBefore);
  };
  // Delay a real worker response after the worker completes it. The mutation and
  // all checks run normally. Only delivery to the editor is gated.
  const hold = async (action, trigger, whileHeld) => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    let ready;
    let failed;
    const observed = new Promise((resolve, reject) => { ready = resolve; failed = reject; });
    let completed;
    const completion = new Promise(resolve => { completed = resolve; });
    let entered = false;
    let handlerError;
    const pattern = new RegExp(`/api/editor/sessions/[^/]+/${action}$`);
    const handler = async route => {
      entered = true;
      try {
        const response = await route.fetch({ timeout });
        ready(response.status());
        await gate;
        await route.fulfill({ response });
      } catch (error) { handlerError = error; failed(error); }
      finally { completed(); }
    };
    await page.route(pattern, handler);
    let timer;
    try {
      await trigger();
      const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`No ${action} response to delay`)), timeout); });
      const status = await Promise.race([observed, deadline]);
      assert.equal(status, 200, `${action} succeeded before its response was delayed`);
      await whileHeld();
    } finally {
      clearTimeout(timer);
      release();
      // Removing a handler while its response is still being fulfilled can
      // continue the original request. For mutations that would apply twice.
      if (entered) await completion;
      await page.unroute(pattern, handler);
      if (handlerError) throw handlerError;
    }
  };

  await page.goto(`${origin}/editor`);
  await visibleText(heading(), originalHeading);
  await wait('native preview ready before selecting', () => page.evaluate(() => window.__neatAcceptanceReadyCount ?? 0), count => count > 0);
  await heading().click();
  await selection();
  await frame().getByText('Hover here while the heading stays selected.', { exact: true }).hover();
  await selection();
  await checkpoint('native selection stays locked while hovering elsewhere', 'selection');

  await heading().dblclick();
  const editable = frame().locator('main h1[contenteditable]');
  await editable.waitFor();
  await editable.fill(editedHeading);
  await editable.press('Enter');
  await pending();
  await visibleText(heading(), editedHeading);
  await selection();
  assert.equal(await padding().isDisabled(), true, 'Inspector remains visible and locked during pending review');
  await keep();
  await wait('one kept text step', () => steps().count(), n => n === 1);
  await checkpoint('native text edit, pending inspector, and Keep', 'text');

  await paddingIs(17);
  await page.getByLabel('Override app styles for new changes', { exact: true }).check();
  await padding().selectOption('6');
  await pending();
  await paddingIs(24);
  await keep();
  await padding().selectOption('8');
  await pending();
  await paddingIs(32);

  await hold('inspect', () => page.getByRole('button', { name: 'Undo', exact: true }).click(), async () => {
    // The control can disappear while inspection reloads. If retained, it must
    // remain disabled until the current source and tag are available.
    const count = await padding().count();
    assert.ok(count === 0 || await padding().isDisabled(), 'No stale property control is enabled during delayed inspection after Undo');
  });
  await settled();
  await wait('fresh controls after delayed inspection', () => padding().isEnabled(), Boolean);
  await paddingIs(24);
  await selection();
  await checkpoint('computed property edits, pending Undo, and delayed inspection lock', 'propertyAndPendingUndo');

  await hold('inspect', () => padding().selectOption('8'), async () => {
    await fullReload();
  });
  await pending();
  await selection();
  await paddingIs(32);
  await undoPending();
  await selection();
  await paddingIs(24);
  await checkpoint('full iframe reload while inspection is delayed preserves selection and the next edit', 'reloadDuringInspection');

  await steps().last().getByRole('button', { name: /^Undo step / }).click();
  await steps().last().getByText(/^Undone ·/).waitFor();
  assert.equal(await steps().last().getByRole('button', { name: /^Undo step / }).count(), 0, 'Undone step has no Undo action');
  await paddingIs(17);
  await wait('controls after latest-step undo', () => padding().isEnabled(), Boolean);
  await checkpoint('latest kept Undo restores the preview and marks its timeline row Undone', 'keptUndo');
  // An insertion moves the heading's source tag. This makes full navigation
  // before and after a delayed response exercise selection relocation too.
  const ask = async instruction => {
    await page.locator('#ask').fill(instruction);
    await page.getByRole('button', { name: 'Ask', exact: true }).click();
  };
  await hold('ask', () => ask('acceptance insert before heading'), async () => {
    await fullReload();
    await frame().getByText('Inserted by scripted Ask', { exact: true }).waitFor();
  });
  await pending();
  await selection();
  await undoPending();
  await frame().getByText('Inserted by scripted Ask', { exact: true }).waitFor({ state: 'hidden' });
  await selection();
  await checkpoint('full iframe reload before delayed Ask reply preserves relocated selection', 'reloadBeforeReply');

  await hold('ask', () => ask('acceptance insert before heading'), async () => {});
  await pending();
  await fullReload();
  await frame().getByText('Inserted by scripted Ask', { exact: true }).waitFor();
  await selection();
  await keep();
  await checkpoint('full iframe reload after delayed Ask reply preserves relocated selection', 'reloadAfterReply');

  await page.getByLabel('Override app styles for new changes', { exact: true }).check();
  await padding().selectOption('6');
  await pending();
  await paddingIs(24);
  await keep();
  await steps().first().getByText('Code and checks', { exact: true }).click();
  await steps().first().getByText(/Not run yet:.*lint.*render/).waitFor();
  assert.match(await steps().first().locator('pre').innerText(), /A kept browser edit/);
  await checkpoint('timeline diff and honest check labels', 'timeline');

  await frame().locator('main h2').click();
  const callsBefore = provider.calls.length;
  await ask('acceptance shared label');
  const confirmation = page.locator('section[aria-labelledby="shared-title"]');
  await confirmation.getByRole('button', { name: 'Change everywhere', exact: true }).waitFor();
  await confirmation.getByText('app/about/page.tsx', { exact: true }).waitFor();
  await confirmation.getByText('app/page.tsx', { exact: true }).waitFor();
  const sites = confirmation.getByRole('list', { name: 'Places AcceptanceBadge is rendered' });
  assert.equal(await sites.locator('li').count(), 2);
  await visibleText(frame().locator('main h2'), 'Shared acceptance label');
  await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
  await confirmation.waitFor({ state: 'hidden' });
  await visibleText(frame().locator('main h2'), 'Shared acceptance label');
  await ask('acceptance shared label');
  await confirmation.getByRole('button', { name: 'Change everywhere', exact: true }).click();
  await pending();
  await visibleText(frame().locator('main h2'), 'Confirmed shared label');
  assert.equal(provider.calls.length, callsBefore + 2, 'Confirmation replays operations without another model call');
  await page.getByRole('button', { name: 'Keep', exact: true }).click();
  await settled();
  await wait('shared selection refreshed after Keep', () => page.locator('#ask').isEnabled(), Boolean);
  await checkpoint('shared impact, Cancel, and deterministic confirmation through production model adapter', 'sharedConfirmation');

  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await frame().getByRole('link', { name: 'About', exact: true }).click();
  await visibleText(frame().locator('main h2'), 'Confirmed shared label');
  await wait('native navigation to About', async () => {
    const element = await page.locator('iframe').elementHandle();
    return (await element.contentFrame()).url();
  }, url => new URL(url).pathname === '/about');
  await page.getByLabel('Page', { exact: true }).fill('/');
  await page.getByLabel('Page', { exact: true }).press('Enter');
  await visibleText(heading(), editedHeading);
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await checkpoint('native route navigation displays the confirmed shared change on About', 'routeNavigation');

  const kept = await steps().count();
  await page.reload();
  await visibleText(heading(), editedHeading);
  await paddingIs(24);
  await wait('timeline survives browser reload', () => steps().count(), n => n === kept);
  await restart();
  await page.goto(`${origin}/editor`);
  await visibleText(heading(), editedHeading);
  await paddingIs(24);
  await visibleText(frame().locator('main h2'), 'Confirmed shared label');
  await wait('timeline survives worker restart', () => steps().count(), n => n === kept);
  await checkpoint('browser reload and real CLI restart restore kept pass', 'restart');

  await page.getByLabel('Branch name', { exact: true }).fill('browser-acceptance');
  await page.getByRole('button', { name: 'Create branch', exact: true }).click();
  await page.getByText('neat/browser-acceptance', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Export patch', exact: true }).click();
  const link = page.getByRole('link', { name: /^Download .*\.patch$/ });
  await link.waitFor();
  const download = page.waitForEvent('download');
  await link.click();
  await (await download).saveAs(join(evidence, 'delivery.patch'));

  await page.setViewportSize({ width: 390, height: 844 });
  const deliver = page.getByRole('region', { name: 'Deliver this pass' });
  await deliver.scrollIntoViewIfNeeded();
  const bounds = await deliver.boundingBox();
  assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 391, 'Delivery panel fits the mobile viewport');
  await page.getByRole('button', { name: 'Create branch', exact: true }).focus();
  await page.keyboard.press('Tab');
  assert.equal(await page.getByRole('button', { name: 'Export patch', exact: true }).evaluate(el => el === document.activeElement), true);
  await page.screenshot({ path: join(evidence, 'final.png'), fullPage: true });
  await checkpoint('native branch and patch delivery, mobile fit, and keyboard navigation', 'delivery');
}
