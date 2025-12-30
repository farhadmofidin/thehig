import { z } from "zod";

export const generateRequestSchema = z.object({
  imageDataUrl: z.string().optional(),
  prompt1: z.string().min(1, "Prompt 1 is required"),
  prompt2: z.string().min(1, "Prompt 2 is required"),
  model: z.string().default("higgsfield-ai/nano-banana"),
  aspectRatio: z.string().default("16:9"),
  resolution: z.string().default("720p"),
});

export type GenerateRequest = z.infer<typeof generateRequestSchema>;

export interface LogEntry {
  id: string;
  timestamp: string;
  message: string;
  type: "info" | "success" | "error" | "pending";
}

export interface GenerationJob {
  id: string;
  requestId1: string;
  requestId2: string;
  status: "queued" | "in_progress" | "completed" | "failed" | "nsfw";
  prompt1: string;
  prompt2: string;
  sourceImage?: string;
  generatedImageUrl1?: string;
  generatedImageUrl2?: string;
  logs: LogEntry[];
  createdAt: Date;
}