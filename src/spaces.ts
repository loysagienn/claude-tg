import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import type { SpacesConfig } from "./config.js";

const CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
};

function contentType(path: string): string {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}

export type Uploader = (localPath: string) => Promise<string>;

/**
 * Build an uploader bound to a DigitalOcean Spaces bucket. The returned
 * function uploads a local file with a public-read ACL and resolves to its
 * public URL.
 *
 * The SDK endpoint is the *regional* base (e.g. https://ams3.digitaloceanspaces.com)
 * with virtual-hosted addressing, so the bucket becomes a subdomain — matching
 * the public URL in `config.publicBase`.
 */
export function createUploader(config: SpacesConfig): Uploader {
  const client = new S3Client({
    region: config.region,
    endpoint: `https://${config.region}.digitaloceanspaces.com`,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });

  return async (localPath: string): Promise<string> => {
    const key = `telegram/${Date.now()}-${basename(localPath)}`;
    await client.send(
      new PutObjectCommand({
        Bucket: config.bucket,
        Key: key,
        Body: readFileSync(localPath),
        ACL: "public-read",
        ContentType: contentType(localPath),
      }),
    );
    return `${config.publicBase}/${key}`;
  };
}
