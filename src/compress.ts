import { promises as fs } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { estimateImageTokens } from "./tokens.js";

export type ImageFormat = "webp" | "jpeg" | "png";

export interface CompressOptions {
  path: string;
  max_dim?: number;
  format?: ImageFormat;
  quality?: number;
  output_path?: string;
}

export interface CompressResult {
  input_path: string;
  output_path: string;
  input_bytes: number;
  output_bytes: number;
  input_dims: { width: number; height: number };
  output_dims: { width: number; height: number };
  ratio: number;
  est_token_savings: {
    before: number;
    after: number;
    saved: number;
  };
}

const DEFAULTS = {
  max_dim: 1568,
  format: "webp" as ImageFormat,
  quality: 85,
};

function defaultOutputPath(inputPath: string, format: ImageFormat): string {
  const dir = path.dirname(inputPath);
  const base = path.basename(inputPath, path.extname(inputPath));
  return path.join(dir, `${base}.compressed.${format}`);
}

async function assertImageFile(filePath: string): Promise<void> {
  if (!path.isAbsolute(filePath)) {
    throw new Error(`Path must be absolute: ${filePath}`);
  }
  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch {
    throw new Error(`File not found: ${filePath}`);
  }
  if (!stat.isFile()) {
    throw new Error(`Not a regular file: ${filePath}`);
  }
}

export async function compressImage(opts: CompressOptions): Promise<CompressResult> {
  const inputPath = opts.path;
  const maxDim = opts.max_dim ?? DEFAULTS.max_dim;
  const format = opts.format ?? DEFAULTS.format;
  const quality = opts.quality ?? DEFAULTS.quality;

  if (!Number.isFinite(maxDim) || maxDim <= 0) {
    throw new Error(`max_dim must be a positive number, got ${maxDim}`);
  }
  if (!Number.isFinite(quality) || quality < 1 || quality > 100) {
    throw new Error(`quality must be 1-100, got ${quality}`);
  }
  if (!["webp", "jpeg", "png"].includes(format)) {
    throw new Error(`format must be webp|jpeg|png, got ${format}`);
  }

  await assertImageFile(inputPath);

  const inputBuf = await fs.readFile(inputPath);
  const inputBytes = inputBuf.length;

  let pipeline = sharp(inputBuf, { failOn: "none" });
  let meta;
  try {
    meta = await pipeline.metadata();
  } catch (err) {
    throw new Error(`Not a readable image: ${inputPath} (${(err as Error).message})`);
  }
  if (!meta.width || !meta.height || !meta.format) {
    throw new Error(`Not a recognized image: ${inputPath}`);
  }

  const inputDims = { width: meta.width, height: meta.height };

  // Resize only when larger than max_dim (no upscale).
  const longest = Math.max(inputDims.width, inputDims.height);
  if (longest > maxDim) {
    pipeline = pipeline.resize({
      width: inputDims.width >= inputDims.height ? maxDim : undefined,
      height: inputDims.height > inputDims.width ? maxDim : undefined,
      fit: "inside",
      withoutEnlargement: true,
    });
  }

  // Re-encode in target format.
  switch (format) {
    case "webp":
      pipeline = pipeline.webp({ quality });
      break;
    case "jpeg":
      pipeline = pipeline.jpeg({ quality, mozjpeg: true });
      break;
    case "png":
      // PNG is lossless; map quality to compressionLevel (0-9).
      pipeline = pipeline.png({
        compressionLevel: Math.round(((100 - quality) / 100) * 9),
      });
      break;
  }

  const outputPath = opts.output_path ?? defaultOutputPath(inputPath, format);
  if (!path.isAbsolute(outputPath)) {
    throw new Error(`output_path must be absolute: ${outputPath}`);
  }
  // Never overwrite source unless explicitly requested.
  if (
    path.resolve(outputPath) === path.resolve(inputPath) &&
    opts.output_path !== inputPath
  ) {
    throw new Error(
      `Refusing to overwrite source. Pass output_path explicitly to overwrite.`,
    );
  }

  const { data: outBuf, info } = await pipeline.toBuffer({ resolveWithObject: true });
  await fs.writeFile(outputPath, outBuf);

  const outputDims = { width: info.width, height: info.height };
  const before = estimateImageTokens(inputDims.width, inputDims.height);
  const after = estimateImageTokens(outputDims.width, outputDims.height);

  return {
    input_path: inputPath,
    output_path: outputPath,
    input_bytes: inputBytes,
    output_bytes: outBuf.length,
    input_dims: inputDims,
    output_dims: outputDims,
    ratio: inputBytes > 0 ? outBuf.length / inputBytes : 0,
    est_token_savings: {
      before,
      after,
      saved: Math.max(0, before - after),
    },
  };
}

export interface BatchOptions extends Omit<CompressOptions, "path" | "output_path"> {
  paths: string[];
}

export interface BatchResult {
  results: Array<{ ok: true; result: CompressResult } | { ok: false; path: string; error: string }>;
  aggregate: {
    files: number;
    succeeded: number;
    failed: number;
    input_bytes: number;
    output_bytes: number;
    bytes_saved: number;
    est_tokens_before: number;
    est_tokens_after: number;
    est_tokens_saved: number;
  };
}

export async function compressImageBatch(opts: BatchOptions): Promise<BatchResult> {
  const out: BatchResult["results"] = [];
  let inBytes = 0;
  let outBytes = 0;
  let tokBefore = 0;
  let tokAfter = 0;
  let succeeded = 0;
  let failed = 0;

  for (const p of opts.paths) {
    try {
      const r = await compressImage({
        path: p,
        max_dim: opts.max_dim,
        format: opts.format,
        quality: opts.quality,
      });
      out.push({ ok: true, result: r });
      inBytes += r.input_bytes;
      outBytes += r.output_bytes;
      tokBefore += r.est_token_savings.before;
      tokAfter += r.est_token_savings.after;
      succeeded++;
    } catch (err) {
      out.push({ ok: false, path: p, error: (err as Error).message });
      failed++;
    }
  }

  return {
    results: out,
    aggregate: {
      files: opts.paths.length,
      succeeded,
      failed,
      input_bytes: inBytes,
      output_bytes: outBytes,
      bytes_saved: Math.max(0, inBytes - outBytes),
      est_tokens_before: tokBefore,
      est_tokens_after: tokAfter,
      est_tokens_saved: Math.max(0, tokBefore - tokAfter),
    },
  };
}
