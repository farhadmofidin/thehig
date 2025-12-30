"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateRequestSchema = void 0;
const zod_1 = require("zod");
exports.generateRequestSchema = zod_1.z.object({
    imageDataUrl: zod_1.z.string().optional(),
    prompt1: zod_1.z.string().min(1, "Prompt 1 is required"),
    prompt2: zod_1.z.string().min(1, "Prompt 2 is required"),
    model: zod_1.z.string().default("higgsfield-ai/nano-banana"),
    aspectRatio: zod_1.z.string().default("16:9"),
    resolution: zod_1.z.string().default("720p"),
});
