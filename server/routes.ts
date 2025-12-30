import express from "express";
import { v4 as uuidv4 } from "uuid";
import { generateRequestSchema, GenerationJob, LogEntry } from "../shared/schema.js";
import { storage } from "./storage.js";

const router = express.Router();

const HIGGSFIELD_BASE_URL = "https://platform.higgsfield.ai";
const MODEL = "higgsfield-ai/nano-banana";
const API_KEY = process.env.HIGGSFIELD_API_KEY;
const API_SECRET = process.env.HIGGSFIELD_API_SECRET;

if (!API_KEY || !API_SECRET) {
  throw new Error("HIGGSFIELD_API_KEY and HIGGSFIELD_API_SECRET must be set");
}

function createLogEntry(message: string, type: LogEntry["type"]): LogEntry {
  return {
    id: uuidv4(),
    timestamp: new Date().toISOString(),
    message,
    type,
  };
}

async function submitGenerationRequest(prompt: string, imageDataUrl?: string) {
  const body: any = {
    prompt,
    aspect_ratio: "16:9",
    resolution: "720p",
  };

  if (imageDataUrl) {
    body.items = [
      {
        type: "image",
        url: imageDataUrl,
      },
    ];
  }

  const response = await fetch(`${HIGGSFIELD_BASE_URL}/${MODEL}`, {
    method: "POST",
    headers: {
      "Authorization": `Key ${API_KEY}:${API_SECRET}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`Higgsfield API error: ${response.status} ${response.statusText}`);
  }

  return await response.json();
}

async function pollStatus(requestId: string): Promise<{ status: string; images?: { url: string }[] }> {
  const response = await fetch(`${HIGGSFIELD_BASE_URL}/requests/${requestId}/status`);
  if (!response.ok) {
    throw new Error(`Status poll error: ${response.status}`);
  }
  return await response.json();
}

async function pollJob(job: GenerationJob) {
  let attempts = 0;
  const maxAttempts = 120; // 4 minutes

  while (attempts < maxAttempts) {
    try {
      const [status1, status2] = await Promise.all([
        pollStatus(job.requestId1),
        pollStatus(job.requestId2),
      ]);

      job.logs.push(createLogEntry(`Polling attempt ${attempts + 1}: Prompt1=${status1.status}, Prompt2=${status2.status}`, "pending"));

      if (status1.status === "completed" && status2.status === "completed") {
        job.status = "completed";
        job.generatedImageUrl1 = status1.images?.[0]?.url;
        job.generatedImageUrl2 = status2.images?.[0]?.url;
        job.logs.push(createLogEntry("Both images generated successfully", "success"));
        storage.set(job.id, job);
        return;
      }

      if (status1.status === "failed" || status2.status === "failed") {
        job.status = "failed";
        job.logs.push(createLogEntry("One or more image generations failed", "error"));
        storage.set(job.id, job);
        return;
      }

      if (status1.status === "nsfw" || status2.status === "nsfw") {
        job.status = "nsfw";
        job.logs.push(createLogEntry("Content flagged as inappropriate", "error"));
        storage.set(job.id, job);
        return;
      }

      if (status1.status === "in_progress" || status2.status === "in_progress") {
        job.status = "in_progress";
      }

      storage.set(job.id, job);
    } catch (error) {
      job.logs.push(createLogEntry(`Polling error: ${error}`, "error"));
      storage.set(job.id, job);
      return;
    }

    attempts++;
    await new Promise(resolve => setTimeout(resolve, 2000)); // 2 seconds
  }

  job.status = "failed";
  job.logs.push(createLogEntry("Timeout: Generation took too long", "error"));
  storage.set(job.id, job);
}

router.post("/api/generate", async (req, res) => {
  try {
    const body = generateRequestSchema.parse(req.body);

    const jobId = uuidv4();
    const logs: LogEntry[] = [];

    logs.push(createLogEntry("Starting image generation for 2 prompts...", "info"));

    // Submit both requests in parallel
    const [response1, response2] = await Promise.all([
      submitGenerationRequest(body.prompt1, body.imageDataUrl),
      submitGenerationRequest(body.prompt2, body.imageDataUrl),
    ]);

    const requestId1 = response1.request_id;
    const requestId2 = response2.request_id;

    logs.push(createLogEntry(`Submitted requests: ${requestId1}, ${requestId2}`, "info"));

    const job: GenerationJob = {
      id: jobId,
      requestId1,
      requestId2,
      status: "queued",
      prompt1: body.prompt1,
      prompt2: body.prompt2,
      sourceImage: body.imageDataUrl,
      logs,
      createdAt: new Date(),
    };

    storage.set(jobId, job);

    // Start polling in background
    pollJob(job);

    res.json({ jobId });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to start generation" });
  }
});

router.get("/api/jobs/:id", (req, res) => {
  const job = storage.get(req.params.id);
  if (!job) {
    return res.status(404).json({ error: "Job not found" });
  }

  res.json(job);
});

export default router;