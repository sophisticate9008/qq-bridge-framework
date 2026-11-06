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
  await page.waitForTimeout(400);
  const geometry = async () => page.evaluate(() => {
    const table = document.querySelector('[data-usage-conversations-scroll]');
    const stats = document.querySelector('[data-usage-statistics]');
    if (!table || !stats) throw new Error('missing_usage_regions');
    return { top: table.getBoundingClientRect().top + scrollY, height: stats.getBoundingClientRect().height };
  });
  const before = await geometry();
  const cardsBefore = await usageCardGeometry(page);
  await page.locator('#usage-chart').evaluate(element => { element.dataset.retainedChart = 'yes'; });
  await page.locator('#usage-chart .recharts-surface').evaluate(element => { element.setAttribute('data-retained-surface', 'yes'); });
  await page.route('**/isolated-native-api/api/chat/usage?**', async route => {
    if (route.request().url().includes('ledgerKeys=')) await new Promise(resolve => setTimeout(resolve, 650));
    await route.continue();
  });
  await rows.nth(0).locator('input').check();
  await page.waitForTimeout(250);
  assert.equal(await page.locator('[data-usage-metric="total-tokens"] > strong').innerText(), '511k');
  assert.equal(await page.locator('[data-usage-window-total]').innerText(), '511k token');
  assert.match(await page.locator('[data-usage-scope]').innerText(), /正在刷新至已选 1 个会话账本.*暂显示全部会话/);
  const during = await geometry();
  assertUsageCardGeometry(cardsBefore, await usageCardGeometry(page));
  assert(Math.abs(before.top - during.top) < 1, JSON.stringify({ before, during }));
  assert(Math.abs(before.height - during.height) < 1, JSON.stringify({ before, during }));
  assert.equal(await page.locator('#usage-chart').getAttribute('data-retained-chart'), 'yes');
  assert.equal(await page.locator('#usage-chart .recharts-surface').getAttribute('data-retained-surface'), 'yes');
  const barFrames = await page.evaluate(async () => {
    const frames: string[] = [];
    for (let index = 0; index < 80; index++) {
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      frames.push([...document.querySelectorAll('#usage-chart .recharts-bar-rectangle path')].map(path => path.getAttribute('d')).join('|'));
    }
    return frames;
  });
  assert(barFrames.every(frame => frame.length > 0), 'Bars must stay mounted while changing scope');
  assert(new Set(barFrames).size > 2, 'Bar geometry must interpolate through intermediate frames');
  await expected(1, 10060);
  const after = await geometry();
  assertUsageCardGeometry(cardsBefore, await usageCardGeometry(page));
  assert(Math.abs(before.top - after.top) < 1, JSON.stringify({ before, after }));
  assert.equal(await page.locator('#usage-chart .recharts-surface').getAttribute('data-retained-surface'), 'yes');
  await page.unrouteAll({ behavior: 'wait' });
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
  // Failed selected reads retain the previous chart, explicitly labelled with its original scope.
  await page.route('**/isolated-native-api/api/chat/usage?**', async route => {
    if (route.request().url().includes('ledgerKeys=')) await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'fixture_unavailable' }) });
    else await route.continue();
  });
  await rows.first().locator('input').check();
  await page.getByText(/所选统计读取失败/).waitFor();
  assertUsageCardGeometry(cardsBefore, await usageCardGeometry(page));
  assert.equal(await page.locator('[data-usage-metric="total-tokens"] > strong').innerText(), '511k');
  assert.equal(await page.locator('[data-usage-scope]').getAttribute('data-stale'), 'true');
  assert.match(await page.locator('[data-usage-scope]').innerText(), /暂显示全部会话/);
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
  await verifyUsageCardStability(page);
}

// Measure each card and the drawing surface: a stable outer wrapper alone is insufficient.
async function usageCardGeometry(page: Page) {
  return page.locator('[data-usage-metric], #usage-series, #usage-model-costs, #usage-chart [data-slot="chart"]').evaluateAll(elements => elements.map(element => {
    const rect = element.getBoundingClientRect();
    return { name: element.getAttribute('data-usage-metric') ?? element.id ?? 'canvas', x: rect.x + scrollX, y: rect.y + scrollY, width: rect.width, height: rect.height };
  }));
}
function assertUsageCardGeometry(before: Awaited<ReturnType<typeof usageCardGeometry>>, after: Awaited<ReturnType<typeof usageCardGeometry>>) {
  assert.equal(after.length, 7);
  for (const [index, old] of before.entries()) {
    const next = after[index]!;
    for (const key of ['x', 'y', 'width', 'height'] as const) assert(Math.abs(old[key] - next[key]) < 1, JSON.stringify({ card: old.name, key, before: old[key], after: next[key] }));
  }
}
async function verifyUsageCardStability(page: Page) {
  await page.locator('[data-native-seed="geometry"]').click();
  await page.locator('#usage-auto-refresh').selectOption('off');
  await page.locator('#usage-model-costs tbody tr').nth(11).waitFor();
  assert.equal(await page.getByLabel('查看时间桶', { exact: true }).count(), 0);
  for (const width of [1600, 1100, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.getByLabel('走势纵轴').selectOption('tokens');
    await page.waitForTimeout(400);
    const before = await usageCardGeometry(page);
    await page.locator('#usage-chart .recharts-surface').evaluate(element => element.setAttribute('data-kept-geometry', 'yes'));
    for (const key of ['group:2000', 'group:2011']) {
      await page.locator(`[data-usage-key="${key}"] input`).check();
      await page.waitForFunction(() => document.querySelector('[data-usage-scope]')?.textContent.includes('已选 1 个会话账本') && document.querySelector('[data-usage-statistics]')?.getAttribute('aria-busy') === 'false');
      assertUsageCardGeometry(before, await usageCardGeometry(page));
      if (key === 'group:2000') assert.equal(await page.locator('[data-usage-metric="cache-hit-rate"] > strong').innerText(), '暂无有效样本');
      for (const metric of ['cost', 'tokens']) {
        await page.getByLabel('走势纵轴').selectOption(metric);
        await page.getByLabel('走势时间范围').selectOption('720');
        await page.waitForFunction(() => document.querySelector('[data-usage-statistics]')?.getAttribute('aria-busy') === 'false');
        await page.getByRole('switch', { name: '详细数值', exact: true }).click();
        assertUsageCardGeometry(before, await usageCardGeometry(page));
      }
      await page.getByRole('button', { name: '查看全部', exact: true }).click();
      await page.locator('#usage-model-costs tbody tr').nth(11).waitFor();
      assertUsageCardGeometry(before, await usageCardGeometry(page));
    }
    assert.equal(await page.locator('#usage-chart .recharts-surface').getAttribute('data-kept-geometry'), 'yes');
    await page.waitForTimeout(400);
    const bar = page.locator('#usage-chart path[data-usage-bucket-index], #usage-chart rect[data-usage-bucket-index]').filter({ visible: true }).last();
    await bar.click();
    await page.getByRole('dialog', { name: '时段明细', exact: true }).waitFor();
    await page.keyboard.press('Escape');
    assertUsageCardGeometry(before, await usageCardGeometry(page));
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  }
  await page.setViewportSize({ width: 1100, height: 1000 });
}
