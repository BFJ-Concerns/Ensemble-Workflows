import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

// Claude creates the projects root, project directory and transcript asynchronously.
// A missing path at any level means the live observer should keep polling.
export async function findClaudeTranscript(projectsRoot: string, sessionId: string): Promise<string | null> {
  try {
    const directories = await readdir(projectsRoot, { withFileTypes: true });
    for (const directory of directories) {
      if (!directory.isDirectory()) continue;
      const candidate = path.join(projectsRoot, directory.name, `${sessionId}.jsonl`);
      try {
        await readFile(candidate, "utf8");
        return candidate;
      } catch (error) {
        if (!isMissingPath(error)) throw error;
      }
    }
    return null;
  } catch (error) {
    if (isMissingPath(error)) return null;
    throw error;
  }
}

function isMissingPath(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
