import { access, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { getDaemonStatus, runDaemonServer, stopDaemon } from "../src/daemon";
import { resolvePaths } from "../src/config";

describe("daemon runtime files", () => {
  test("daemon serve creates the advertised log path", async () => {
    const home = await mkdtemp(join(tmpdir(), "pro-daemon-test-"));
    const paths = resolvePaths({ PRO_CLI_HOME: home });
    const serving = runDaemonServer(paths, { idleTimeoutMs: 10_000 });
    try {
      const status = await waitForRunningDaemon(paths);

      expect(status.state).toBe("running");
      await access(status.logPath);
    } finally {
      await stopDaemon(paths).catch(() => undefined);
      await serving.catch(() => undefined);
      await rm(home, { recursive: true, force: true });
    }
  });
});

async function waitForRunningDaemon(paths: ReturnType<typeof resolvePaths>) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const status = await getDaemonStatus(paths);
    if (status.state === "running") return status;
    await Bun.sleep(25);
  }
  return getDaemonStatus(paths);
}
