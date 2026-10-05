import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { request } from 'node:http';
import { once } from 'node:events';
import { ManagedInstanceRegistry } from '../managed-instance-registry.js';
import { StudioInstanceManager } from '../studio-instance-manager.js';
import { BridgeService } from '../bridge-service.js';
import { RobloxStudioTools } from '../tools/index.js';
import { createHttpServer } from '../http-server.js';

describe('detached launch recovery', () => {
  test('the HTTP lifecycle route forwards client disconnect cancellation', async () => {
    const bridge = new BridgeService();
    const tools = new RobloxStudioTools(bridge);
    let entered!: () => void;
    let cancelled!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const aborted = new Promise<void>(resolve => { cancelled = resolve; });
    jest.spyOn(tools, 'manageInstance').mockImplementation(async (_body, signal) => {
      expect(signal).toBeDefined();
      entered();
      await new Promise<void>(resolve => signal!.addEventListener('abort', () => { cancelled(); resolve(); }, { once: true }));
      throw new Error('Cancelled');
    });
    const app = createHttpServer(tools, bridge);
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address() as { port: number };
    const client = request({ hostname: '127.0.0.1', port: address.port, path: '/mcp/manage_instance', method: 'POST',
      headers: { 'Content-Type': 'application/json' } });
    client.on('error', () => {});
    client.end(JSON.stringify({ action: 'launch' }));
    try {
      await started;
      client.destroy();
      await aborted;
    } finally {
      client.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await app.cleanup();
    }
  });

  test.each(['before_spawn', 'after_spawn'])('disconnect %s prevents an orphan without stopping unrelated Studio', async (phase) => {
    const registryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'detached-launch-'));
    const controller = new AbortController();
    const live = new Set([99]);
    const spawnStudio = jest.fn(() => {
      live.add(11);
      if (phase === 'after_spawn') controller.abort();
      return { pid: 11, nativePid: 11, nativeStartedAt: '1234', unref: () => {} };
    });
    const manager = new StudioInstanceManager({ registryDir, processAdapter: {
      currentBootId: () => 'boot-1',
      resolveStudioExe: () => {
        if (phase === 'before_spawn') controller.abort();
        return 'Studio.exe';
      },
      spawnStudio,
      listStudioProcesses: () => [...live].map(Id => ({ Id, Name: 'RobloxStudioBeta', StartTimeUtcFileTime: '1234' })),
      stopProcess: pid => { live.delete(pid); },
    }});
    try {
      await expect(manager.launch({ source: 'local_file', localPlaceFile: '/tmp/owned.rbxlx' }, controller.signal)).rejects.toThrow();
      expect(spawnStudio).toHaveBeenCalledTimes(phase === 'before_spawn' ? 0 : 1);
      expect([...live]).toEqual([99]);
    } finally { await fs.rm(registryDir, { recursive: true, force: true }); }
  });

  test('a failed boot probe does not mark a running retained process exited', async () => {
    const registryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'detached-boot-'));
    const registry = new ManagedInstanceRegistry(registryDir);
    const cleanupRecord = jest.fn();
    try {
      await registry.upsert({ version: 1, recordId: 'owned', source: 'local_file', exe: 'Studio.exe',
        args: [], launchedAt: Date.now(), bootId: 'windows-boot-1', nativeProcessId: 11, state: 'connected' });
      await registry.sweep({ currentBootId: 'win32:worker:unknown-boot', cleanupRecord,
        observeProcess: () => ({ status: 'running', observedAt: Date.now() }) });
      expect(cleanupRecord).not.toHaveBeenCalled();
      expect(await registry.findAnyByRecordId('owned')).toMatchObject({ state: 'connected', processObservationStatus: 'running' });
    } finally { await fs.rm(registryDir, { recursive: true, force: true }); }
  });
});
