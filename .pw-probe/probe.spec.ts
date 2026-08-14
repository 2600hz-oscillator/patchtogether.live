// Probe: how does Playwright 1.59 record each skip form in the JSON report?
import { test, expect } from '@playwright/test';

// 1. declaration fixme, no details — the current anonymous form
test.fixme('decl fixme anonymous', async () => {});

// 2. declaration fixme WITH a details-object annotation carrying a description
test.fixme(
  'decl fixme with annotation',
  { annotation: { type: 'fixme', description: 'task #999: probe reason' } },
  async () => {},
);

// 3. declaration skip with details annotation
test.skip(
  'decl skip with annotation',
  { annotation: { type: 'skip', description: 'probe skip reason' } },
  async () => {},
);

// 4. in-body runtime guard with reason
test('runtime guard with reason', async () => {
  test.skip(true, 'runtime probe reason');
  expect(1).toBe(2);
});

// 5. bare in-body skip, no reason
test('runtime guard bare', async () => {
  test.skip();
  expect(1).toBe(2);
});

// 6. runtime fixme(true, reason)
test('runtime fixme with reason', async () => {
  test.fixme(true, 'runtime fixme reason');
  expect(1).toBe(2);
});

// 7. plain pass, control
test('passes', async () => {
  expect(1).toBe(1);
});
