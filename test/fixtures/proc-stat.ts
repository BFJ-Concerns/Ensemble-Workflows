import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * A fake `/proc/<pid>/stat` for an injected proc directory. Fields 3–21
 * precede starttime (field 22); the comm field carries a space so the
 * parser's last-close-paren split is what the fixture exercises.
 */
export async function writeProcStat(procDir: string, pid: number, startTicks: string): Promise<void> {
  const dir = path.join(procDir, String(pid));
  await mkdir(dir, { recursive: true });
  const before = ["S", "1", "1", "1", "0", "-1", "4194560", "0", "0", "0", "0", "0", "0", "0", "0", "0", "20", "0", "1"];
  await writeFile(path.join(dir, "stat"), `${pid} (fa ke) ${before.join(" ")} ${startTicks} 0 0\n`);
}
