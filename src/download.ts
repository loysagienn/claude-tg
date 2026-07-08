import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Api } from "grammy";

/**
 * Download a file the user sent to the bot (photo, document, …) into `dir`,
 * returning the absolute path it was saved to. The session agent has
 * filesystem access, so handing it this path is how incoming media reaches it.
 *
 * Uses the Bot API file flow: getFile(file_id) → file_path → fetch from
 * https://api.telegram.org/file/bot<token>/<file_path>. Note the Bot API only
 * serves files up to 20 MB — getFile rejects bigger ones and the caller
 * surfaces that error to the session.
 */
export async function downloadTelegramFile(
  api: Api,
  token: string,
  fileId: string,
  dir: string,
  preferredName?: string,
): Promise<string> {
  const file = await api.getFile(fileId);
  if (!file.file_path) {
    throw new Error("Telegram returned no file_path for the file");
  }

  const res = await fetch(
    `https://api.telegram.org/file/bot${token}/${file.file_path}`,
  );
  if (!res.ok) {
    throw new Error(`file download failed: HTTP ${res.status}`);
  }

  // Prefer the original filename (documents carry one); photos only have the
  // server-side path, whose basename at least keeps the right extension.
  const name = sanitizeName(preferredName ?? basename(file.file_path));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${Date.now()}-${name}`);
  writeFileSync(path, Buffer.from(await res.arrayBuffer()));
  return path;
}

/** Strip path separators / control chars so a filename can't escape `dir`. */
function sanitizeName(name: string): string {
  const cleaned = name.replace(/[/\\\x00-\x1f]+/g, "_");
  return cleaned || "file";
}
