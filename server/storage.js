"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.storage = exports.MemStorage = void 0;
class MemStorage {
    constructor() {
        this.jobs = new Map();
    }
    get(id) {
        return this.jobs.get(id);
    }
    set(id, job) {
        this.jobs.set(id, job);
    }
    delete(id) {
        this.jobs.delete(id);
    }
    getAll() {
        return Array.from(this.jobs.values());
    }
}
exports.MemStorage = MemStorage;
exports.storage = new MemStorage();
