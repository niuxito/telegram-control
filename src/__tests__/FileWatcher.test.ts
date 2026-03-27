import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FileWatcher } from '../watchers/FileWatcher.js';
import os from 'os';
import path from 'path';
import fs from 'fs';

/**
 * FileWatcher integration tests.
 *
 * Strategy:
 * - Use a real temporary directory for chokidar to watch.
 * - Use a short debounce (100ms) injected via the constructor so tests
 *   don't need to mix real/fake timers.
 * - Write real files so chokidar emits genuine FS events.
 * - Wait for the debounce to fire naturally with a small real-time delay.
 */

const DEBOUNCE_MS = 100;
const SETTLE_MS = DEBOUNCE_MS + 200; // time to wait after a write for callback to fire

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fw-test-'));
}

function removeTmpDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
}

describe('FileWatcher', () => {
  let tmpDir: string;
  let watcher: FileWatcher;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(async () => {
    watcher?.stop();
    await wait(50);
    removeTmpDir(tmpDir);
  });

  // -------------------------------------------------------------------------
  it('calls onChange after the debounce period when a file is created', async () => {
    const onChange = vi.fn();
    watcher = new FileWatcher(tmpDir, onChange, DEBOUNCE_MS);
    watcher.start();

    await wait(100); // let chokidar set up its FSWatcher
    fs.writeFileSync(path.join(tmpDir, 'hello.ts'), 'export {}');
    await wait(SETTLE_MS);

    expect(onChange).toHaveBeenCalledOnce();
    const [files] = onChange.mock.calls[0] as [string[]];
    expect(files).toContain('hello.ts');
  }, 10000);

  // -------------------------------------------------------------------------
  it('does NOT call onChange for dotfiles', async () => {
    const onChange = vi.fn();
    watcher = new FileWatcher(tmpDir, onChange, DEBOUNCE_MS);
    watcher.start();

    await wait(100);
    fs.writeFileSync(path.join(tmpDir, '.env'), 'SECRET=1');
    await wait(SETTLE_MS);

    expect(onChange).not.toHaveBeenCalled();
  }, 10000);

  // -------------------------------------------------------------------------
  it('does NOT call onChange for files inside node_modules', async () => {
    const onChange = vi.fn();
    watcher = new FileWatcher(tmpDir, onChange, DEBOUNCE_MS);
    watcher.start();

    await wait(100);
    const nmDir = path.join(tmpDir, 'node_modules', 'some-pkg');
    fs.mkdirSync(nmDir, { recursive: true });
    fs.writeFileSync(path.join(nmDir, 'index.js'), 'module.exports = {}');
    await wait(SETTLE_MS);

    expect(onChange).not.toHaveBeenCalled();
  }, 10000);

  // -------------------------------------------------------------------------
  it('batches multiple file changes into a single callback call', async () => {
    const onChange = vi.fn();
    watcher = new FileWatcher(tmpDir, onChange, DEBOUNCE_MS);
    watcher.start();

    await wait(100);

    // Write multiple files rapidly within the debounce window
    fs.writeFileSync(path.join(tmpDir, 'a.ts'), 'a');
    fs.writeFileSync(path.join(tmpDir, 'b.ts'), 'b');
    fs.writeFileSync(path.join(tmpDir, 'c.ts'), 'c');
    await wait(SETTLE_MS);

    expect(onChange).toHaveBeenCalledOnce();
    const [files] = onChange.mock.calls[0] as [string[]];
    expect(files.length).toBeGreaterThanOrEqual(2);
  }, 10000);

  // -------------------------------------------------------------------------
  it('resets the debounce timer on each new change (does not fire early)', async () => {
    const onChange = vi.fn();
    watcher = new FileWatcher(tmpDir, onChange, DEBOUNCE_MS);
    watcher.start();

    await wait(100);

    // Write first file
    fs.writeFileSync(path.join(tmpDir, 'first.ts'), '1');
    // Write a second file before debounce fires
    await wait(DEBOUNCE_MS - 20);
    expect(onChange).not.toHaveBeenCalled();

    fs.writeFileSync(path.join(tmpDir, 'second.ts'), '2');
    // Now wait for the reset debounce to fire
    await wait(SETTLE_MS);

    expect(onChange).toHaveBeenCalledOnce();
    const [files] = onChange.mock.calls[0] as [string[]];
    expect(files.length).toBeGreaterThanOrEqual(1);
  }, 10000);

  // -------------------------------------------------------------------------
  it('does not call onChange after stop() is called', async () => {
    const onChange = vi.fn();
    watcher = new FileWatcher(tmpDir, onChange, DEBOUNCE_MS);
    watcher.start();

    await wait(100);
    fs.writeFileSync(path.join(tmpDir, 'stop-test.ts'), 'x');
    await wait(30); // well before the debounce fires

    // Stop the watcher before the debounce fires
    watcher.stop();

    await wait(SETTLE_MS);
    expect(onChange).not.toHaveBeenCalled();
  }, 10000);
});
