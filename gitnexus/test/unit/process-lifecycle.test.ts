import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const unref = vi.fn();
const workerCtor = vi.fn(function WorkerMock(this: unknown) {
  return { unref };
});
const spawnMock = vi.fn(() => ({ unref }));

vi.mock('worker_threads', () => ({
  Worker: workerCtor,
}));

vi.mock('child_process', () => ({
  spawn: spawnMock,
}));

describe('process-lifecycle', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let killSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    workerCtor.mockClear();
    spawnMock.mockClear();
    unref.mockClear();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    killSpy = vi.spyOn(process, 'kill').mockImplementation((() => true) as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    killSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it('exports the fatal signal list used by MCP', async () => {
    const { FATAL_SIGNALS } = await import('../../src/util/process-lifecycle.js');
    expect(FATAL_SIGNALS).toEqual(
      expect.arrayContaining(['SIGSEGV', 'SIGBUS', 'SIGILL', 'SIGFPE', 'SIGABRT']),
    );
    // Graceful signals must NOT be treated as fatal — they need cleanup.
    expect(FATAL_SIGNALS).not.toContain('SIGTERM');
    expect(FATAL_SIGNALS).not.toContain('SIGINT');
    expect(FATAL_SIGNALS).not.toContain('SIGHUP');
  });

  it('armSigkillWatchdog spawns an unref’d Worker with SIGKILL payload', async () => {
    const { armSigkillWatchdog } = await import('../../src/util/process-lifecycle.js');
    armSigkillWatchdog(1234);

    expect(workerCtor).toHaveBeenCalledTimes(1);
    const [src, opts] = workerCtor.mock.calls[0] as [string, { eval: boolean }];
    expect(opts).toEqual({ eval: true });
    expect(src).toContain(`process.kill(${process.pid}, 'SIGKILL')`);
    expect(src).toContain('1234');
    expect(unref).toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('armSigkillWatchdog falls back to detached shell when Worker throws', async () => {
    workerCtor.mockImplementationOnce(() => {
      throw new Error('no workers');
    });
    const { armSigkillWatchdog } = await import('../../src/util/process-lifecycle.js');
    armSigkillWatchdog(2500);

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = spawnMock.mock.calls[0] as [
      string,
      string[],
      { detached: boolean; stdio: string },
    ];
    expect(cmd).toBe('sh');
    expect(args[0]).toBe('-c');
    expect(args[1]).toContain(`kill -9 ${process.pid}`);
    expect(args[1]).toMatch(/sleep 3/); // ceil(2500/1000)
    expect(opts).toMatchObject({ detached: true, stdio: 'ignore' });
  });

  it('exitWithWatchdog arms the watchdog then process.exit', async () => {
    const mod = await import('../../src/util/process-lifecycle.js');
    expect(() => mod.exitWithWatchdog(42, 500)).toThrow(/process\.exit did not terminate/);

    expect(workerCtor).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(42);
  });

  it('hardKillSelf sends SIGKILL to self and does not rely on soft exit alone', async () => {
    const mod = await import('../../src/util/process-lifecycle.js');
    expect(() => mod.hardKillSelf()).toThrow(/hardKillSelf did not terminate/);

    expect(killSpy).toHaveBeenCalledWith(process.pid, 'SIGKILL');
    // Fallback path still arms a short watchdog + exit in case kill is mocked away
    expect(workerCtor).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('installFatalSignalHandlers registers SIGSEGV and hard-kills on fire', async () => {
    const onSpy = vi.spyOn(process, 'on');
    const mod = await import('../../src/util/process-lifecycle.js');
    const onFatal = vi.fn();

    mod.installFatalSignalHandlers(onFatal);

    const segvCall = onSpy.mock.calls.find((c) => c[0] === 'SIGSEGV');
    expect(segvCall).toBeDefined();
    const handler = segvCall![1] as () => void;

    expect(() => handler()).toThrow(/hardKillSelf did not terminate/);
    expect(onFatal).toHaveBeenCalledWith('SIGSEGV');
    expect(killSpy).toHaveBeenCalledWith(process.pid, 'SIGKILL');

    onSpy.mockRestore();
  });
});
