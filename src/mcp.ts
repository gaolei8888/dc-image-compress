import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { compressImage, compressImageBatch } from "./compress.js";

const formatEnum = z.enum(["webp", "jpeg", "png"]);

const commonShape = {
  max_dim: z.number().int().positive().default(1568)
    .describe("Resize so longest edge <= this value. No upscaling. Default 1568 (Anthropic's optimal long-edge)."),
  format: formatEnum.default("webp")
    .describe("Output format. Default webp for best size/quality."),
  quality: z.number().int().min(1).max(100).default(85)
    .describe("Encoder quality 1-100 (PNG: maps to compressionLevel)."),
};

const compressImageInput = z.object({
  path: z.string().describe("Absolute path to source image."),
  output_path: z.string().optional()
    .describe("Absolute output path. Default: <dir>/<name>.compressed.<ext>."),
  ...commonShape,
});

const compressBatchInput = z.object({
  paths: z.array(z.string()).min(1).describe("Absolute paths to source images."),
  ...commonShape,
});

export async function runMcpServer(): Promise<void> {
  const server = new McpServer(
    { name: "dc-img-compress", version: "0.2.0" },
    {
      instructions:
        "Compress images locally before sending to a model to save vision tokens. " +
        "Use compress_image for one file, compress_image_batch for many. " +
        "Default 1568px long edge matches Anthropic's recommended max for vision.",
    },
  );

  server.registerTool(
    "compress_image",
    {
      description:
        "Resize (downscale only) and re-encode an image to reduce file size and vision tokens. Returns dimensions, byte sizes, ratio, and estimated token savings.",
      inputSchema: compressImageInput.shape,
    },
    async (args) => {
      const result = await compressImage(args);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.registerTool(
    "compress_image_batch",
    {
      description:
        "Compress multiple images. Returns per-file results plus aggregate byte and token savings.",
      inputSchema: compressBatchInput.shape,
    },
    async (args) => {
      const result = await compressImageBatch(args);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("dc-img-compress MCP server running on stdio");
}
