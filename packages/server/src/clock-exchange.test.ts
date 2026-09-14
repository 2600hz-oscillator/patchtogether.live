import { it, expect, vi } from 'vitest';
import { createHeartbeatExtension } from './heartbeat.js';

it('answers only the requesting connection with both server timestamps and a stable session', async () => {
  const now = vi.fn().mockReturnValueOnce(1000).mockReturnValueOnce(1040).mockReturnValue(2000);
  const extension = createHeartbeatExtension({ now });
  const sendStateless = vi.fn();
  for (const id of [1, 2]) {
    await extension.onStateless!({ payload: JSON.stringify({ type: 'clock-ping', id }), connection: { sendStateless } } as never);
  }
  const first = JSON.parse(sendStateless.mock.calls[0]![0]);
  const second = JSON.parse(sendStateless.mock.calls[1]![0]);
  expect(first).toEqual({ type: 'clock-pong', id: 1, session: expect.any(String), serverRecvTs: 1000, serverSendTs: 1040 });
  expect(second.session).toBe(first.session);
  expect(second.id).toBe(2);
});

it('ignores unrelated, malformed and oversized messages', async () => {
  const extension = createHeartbeatExtension();
  const sendStateless = vi.fn();
  for (const payload of ['null', '{', '{}', '[]', '"hello"', '{"type":"clock-ping","id":"1"}', 'x'.repeat(257)]) {
    await extension.onStateless!({ payload, connection: { sendStateless } } as never);
  }
  expect(sendStateless).not.toHaveBeenCalled();
});
