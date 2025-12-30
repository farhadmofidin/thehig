import { GenerationJob } from "../shared/schema.js";

export class MemStorage {
  private jobs = new Map<string, GenerationJob>();

  get(id: string): GenerationJob | undefined {
    return this.jobs.get(id);
  }

  set(id: string, job: GenerationJob): void {
    this.jobs.set(id, job);
  }

  delete(id: string): void {
    this.jobs.delete(id);
  }

  getAll(): GenerationJob[] {
    return Array.from(this.jobs.values());
  }
}

export const storage = new MemStorage();