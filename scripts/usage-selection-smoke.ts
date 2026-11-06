import assert from 'node:assert/strict';
import type { Page } from 'playwright';
import { formatUsageCount } from '../web/lib/activity.ts';

export async function verifyUsageSelection(page: Page): Promise<void> {
  await page.locator('[data-native-seed="selection"]').click();
  await page.locator('#usage-auto-refresh').selectOption('off');
  await page.waitForFunction(() => document.querySelector('[data-usage-metric="total-tokens"] > strong')?.textContent === '511k');
  await page.getByLabel('走势纵轴').selectOption('tokens');
  const viewport = page.locator('[data-usage-conversations-scroll]');
  const rows = viewport.locator('[data-usage-ledger-key]');
  async function expected(count: number, tokens: number) {
    const formatted = formatUsageCount(tokens, false);
    await page.waitForFunction(({ count, formatted }) => {
      const scope = document.querySelector('[data-usage-scope]')?.textContent ?? '';
      return scope.includes(count ? `已选 ${count} 个会话账本` : '全部会话')
        && document.querySelector('[data-usage-metric="total-tokens"] > strong')?.textContent === formatted
        && document.querySelector('[data-usage-window-total]')?.textContent === `${formatted} token`
        && !scope.includes('正在刷新');
    }, { count, formatted });
  }
  await expected(0, 511000);
  await rows.nth(0).locator('input').check();
  await expected(1, 10060);
  assert.equal(await page.locator('[data-usage-metric="cache-hit-rate"] > strong').innerText(), '0.4%');
  await page.getByRole('tab', { name: '调用记录', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('[data-usage-recent]').length === 1);
  await page.getByRole('tab', { name: '按会话', exact: true }).click();
  await rows.nth(2).locator('[data-usage-selectable-name]').click({ modifiers: ['Control'] });
  await expected(2, 19920);
  await rows.nth(4).locator('input').click({ modifiers: ['Shift'] });
  await expected(4, 39340);
  await rows.nth(3).locator('input').click({ modifiers: ['Alt'] });
  await expected(3, 29580);
  // Checkboxes remain keyboard operable; space dispatches one selection change.
  await rows.nth(3).locator('input').focus();
  await page.keyboard.press('Space');
  await expected(4, 39340);
  await viewport.focus();
  await page.keyboard.press('Control+a');
  await expected(100, 511000);
  await page.keyboard.press('Escape');
  await expected(0, 511000);
  // Hold and drag a real pointer over three rows, then subtract with Alt.
  async function drag(from: number, to: number, alt = false) {
    await rows.nth(from).scrollIntoViewIfNeeded();
    const a = await rows.nth(from).locator('td').nth(2).boundingBox();
    const b = await rows.nth(to).locator('td').nth(3).boundingBox();
    assert(a && b);
    if (alt) await page.keyboard.down('Alt');
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(480);
    await page.locator('[data-usage-selection-box]').waitFor();
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 8 });
    await page.waitForTimeout(80);
    await page.mouse.up();
    if (alt) await page.keyboard.up('Alt');
  }
  await drag(0, 2);
  await expected(3, 29880);
  await drag(1, 2, true);
  await expected(1, 10060);
  await page.locator('#usage-refresh').click();
  await expected(1, 10060);
  await page.getByRole('button', { name: '查看全部', exact: true }).click();
  await expected(0, 511000);
  // A late response for a previous selection must not overwrite the newer one.
  let delayed = false;
  await page.route('**/isolated-native-api/api/chat/usage?**', async route => {
    if (route.request().url().includes('ledgerKeys=') && !delayed) {
      delayed = true;
      await new Promise(resolve => setTimeout(resolve, 600));
    }
    await route.continue();
  });
  await rows.nth(0).locator('input').check();
  await page.waitForTimeout(220);
  await rows.nth(1).locator('td').nth(2).click();
  await expected(1, 9960);
  await page.waitForTimeout(650);
  await expected(1, 9960);
  await page.unrouteAll({ behavior: 'wait' });
  // Virtual rows retain logical selection beyond the currently mounted range.
  await viewport.focus();
  await page.keyboard.press('Control+a');
  await expected(100, 511000);
  await viewport.evaluate(element => { element.scrollTop = element.scrollHeight; });
  await page.waitForTimeout(100);
  assert(await rows.count() < 100);
  assert.equal(await rows.locator('input:not(:checked)').count(), 0);
  await rows.last().locator('input').click({ modifiers: ['Alt'] });
  await expected(99, 510840);
  await viewport.focus();
  await page.keyboard.press('Escape');
  await expected(0, 511000);
  // Drag past the scroll edge; logical range includes virtualized rows in between.
  await viewport.evaluate(element => { element.scrollTop = 0; });
  const firstRow = viewport.locator('[data-virtual-index="0"]');
  await firstRow.waitFor();
  await firstRow.scrollIntoViewIfNeeded();
  const start = await firstRow.locator('td').nth(2).boundingBox();
  const bounds = await viewport.boundingBox();
  assert(start && bounds);
  await page.mouse.move(start.x + 10, start.y + start.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(480);
  await page.mouse.move(start.x + 10, bounds.y + bounds.height - 3, { steps: 8 });
  await page.waitForTimeout(700);
  assert(await viewport.evaluate(element => element.scrollTop > 100));
  // Escape restores the baseline and must not allow pointer-up to select a row.
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expected(0, 511000);
  // A failed selected read stays unavailable rather than showing the all-session total.
  await page.route('**/isolated-native-api/api/chat/usage?**', async route => {
    if (route.request().url().includes('ledgerKeys=')) await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'fixture_unavailable' }) });
    else await route.continue();
  });
  await rows.first().locator('input').check();
  await page.getByText(/所选统计读取失败/).waitFor();
  assert.equal(await page.locator('[data-usage-metric="total-tokens"]').count(), 0);
  await page.unrouteAll({ behavior: 'wait' });
  const failedIndex = Number(await rows.first().getAttribute('data-virtual-index'));
  await page.route('**/isolated-native-api/api/chat/usage?**', async route => {
    if (!route.request().url().includes('ledgerKeys=')) await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'fixture_list_unavailable' }) });
    else await route.continue();
  });
  await page.locator('#usage-refresh').click();
  await expected(1, 100 * (100 - failedIndex) + 60);
  await page.unrouteAll({ behavior: 'wait' });
  await page.getByRole('button', { name: '查看全部', exact: true }).click();
  await expected(0, 511000);
  await page.setViewportSize({ width: 390, height: 1000 });
  await page.waitForFunction(() => document.documentElement.scrollWidth <= innerWidth + 1, null, { timeout: 5000 });
  await page.setViewportSize({ width: 1100, height: 1000 });
}
