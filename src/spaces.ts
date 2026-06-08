import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { SpacesConfig } from "./config.js";

// Presigned URL lifetime. Telegram fetches the photo within seconds of the
// sendPhoto call and then stores its own copy, so a short window is plenty
// while keeping the object unreachable afterwards.
const PRESIGN_EXPIRES_SECONDS = 600;

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
 * function uploads a local file with a PRIVATE ACL and resolves to a short-lived
 * presigned GET URL. The object is not publicly readable; only the holder of the
 * signed URL can fetch it, and the signature expires after
 * PRESIGN_EXPIRES_SECONDS. Telegram downloads the photo immediately and keeps
 * its own copy, so the link does not need to stay valid.
 *
 * The SDK endpoint is the *regional* base (e.g. https://ams3.digitaloceanspaces.com)
 * with virtual-hosted addressing, so the bucket becomes a subdomain.
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
        ACL: "private",
        ContentType: contentType(localPath),
      }),
    );
    return await getSignedUrl(
      client,
      new GetObjectCommand({ Bucket: config.bucket, Key: key }),
      { expiresIn: PRESIGN_EXPIRES_SECONDS },
    );
  };
}
