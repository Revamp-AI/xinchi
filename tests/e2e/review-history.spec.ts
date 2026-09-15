import { expect, test } from '@playwright/test';

for (const theme of ['light', 'dark']) {
  test(`past reviews contain long previews and remain selectable in ${theme} mode`, async ({
    page,
  }, testInfo) => {
    const briefs = Array.from(
      { length: 5 },
      (_, i) =>
        `Fictional review ${i + 1}: ` +
        'The Orchard release needs a clear owner and a confirmed checkpoint. '.repeat(
          8,
        ) +
        (i === 2 ? 'x'.repeat(250) : ''),
    );
    await page.route('**/api/state', async (route) => {
      const response = await route.fetch(),
        state = await response.json();
      state.jobs = briefs.map((brief, i) => ({
        id: 'history-fixture-' + i,
        status: 'complete',
        kind: i === 1 ? 'import_review' : 'review',
        created_at: `2026-09-15T${String(15 - i).padStart(2, '0')}:00:00Z`,
        prompt:
          i === 2
            ? 'Follow-up to review\nOriginal request: Check the fictional launch.'
            : 'Review the fictional launch and its open decisions.',
        result: {
          brief,
          findings: [],
          questions: [],
          proposals: [],
          drafts: [],
          coverage_note: 'Fictional fixture.',
        },
      }));
      await route.fulfill({ json: state });
    });
    await page.goto('/');
    await page.getByRole('button', { name: 'Change appearance' }).click();
    await page
      .getByRole('menuitemradio', {
        name: theme === 'dark' ? 'Dark' : 'Light',
        exact: true,
      })
      .click();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toBeHidden();
    const history = page.getByRole('region', { name: 'Past reviews' }),
      rows = history.getByRole('button');
    await expect(rows).toHaveCount(5);
    await history.scrollIntoViewIfNeeded();
    const geometry = await rows.evaluateAll((elements) =>
      elements.map((element) => {
        const box = element.getBoundingClientRect();
        return {
          top: box.top,
          bottom: box.bottom,
          height: box.height,
          scrollHeight: element.scrollHeight,
          clientHeight: element.clientHeight,
          scrollWidth: element.scrollWidth,
          clientWidth: element.clientWidth,
          children: [...element.children].map((child) => {
            const r = child.getBoundingClientRect();
            return { top: r.top, bottom: r.bottom };
          }),
        };
      }),
    );
    for (let i = 0; i < geometry.length; i++) {
      const row = geometry[i];
      expect(row.height).toBeGreaterThan(70);
      for (const child of row.children) {
        expect(child.top).toBeGreaterThanOrEqual(row.top);
        expect(child.bottom).toBeLessThanOrEqual(row.bottom + 1);
      }
      if (i) expect(row.top).toBeGreaterThanOrEqual(geometry[i - 1].bottom);
    }
    await rows.nth(3).click();
    await expect(rows.nth(3)).toHaveAttribute('aria-current', 'true');
    await expect(
      page.getByRole('heading', { name: 'Earlier review', exact: true }),
    ).toBeVisible();
    await expect(page.locator('.review-brief')).toHaveText(briefs[3]);
    await rows.nth(0).focus();
    await page.keyboard.press('Enter');
    await expect(rows.nth(0)).toHaveAttribute('aria-current', 'true');
    await history.scrollIntoViewIfNeeded();
    await history.screenshot({
      path: testInfo.outputPath(`review-history-${theme}.png`),
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  });
}
