export function signalProcessGroup(pid: number, signal: NodeJS.Signals, fallback: () => void): void {
  try {
    if (process.platform === "win32") fallback();
    else process.kill(-pid, signal);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : null;
    if (code !== "ESRCH") throw error;
  }
}

export function processGroupMembers(groupId: number): number[] {
  if (process.platform === "win32") return [];
  const output = Bun.spawnSync(["ps", "-axo", "pid=,pgid="]).stdout.toString();
  return output.split("\n").flatMap((line) => {
    const [pidText, groupText] = line.trim().split(/\s+/, 2);
    return Number(groupText) === groupId && Number(pidText) > 1 ? [Number(pidText)] : [];
  });
}

export async function cleanupProcessGroup(pid: number, fallback: () => void, timeoutMs = 1_000): Promise<number[]> {
  if (processGroupMembers(pid).length === 0) return [];
  signalProcessGroup(pid, "SIGTERM", fallback);
  const deadline = Date.now() + timeoutMs;
  while (processGroupMembers(pid).length > 0 && Date.now() < deadline) await Bun.sleep(25);
  if (processGroupMembers(pid).length > 0) signalProcessGroup(pid, "SIGKILL", fallback);
  const killDeadline = Date.now() + timeoutMs;
  while (processGroupMembers(pid).length > 0 && Date.now() < killDeadline) await Bun.sleep(25);
  return processGroupMembers(pid);
}
