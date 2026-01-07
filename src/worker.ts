import 'reflect-metadata';
import fs from 'fs/promises';
import path from 'path';
import puppeteer, { type Browser } from 'puppeteer';
import { container, singleton } from 'tsyringe';
import dotenv from 'dotenv';
import { RabbitClient } from './rabbit.js';
import { CacheService } from './cache.js';
import { ConfigService, type AppConfig } from './config.js';

dotenv.config();

interface RenderTask {
  url: string;
  requestedAt: string;
  queueId: string;
}

@singleton()
class Worker {
  private browser: Browser | null = null;
  private readonly queue: Array<{
    task: RenderTask;
    resolve: () => void;
    reject: (err: unknown) => void;
  }> = [];
  private active = 0;

  private readonly configValues: AppConfig;
  private readonly maxConcurrent: number;

  constructor(
    private readonly rabbit: RabbitClient,
    private readonly cache: CacheService,
    config: ConfigService,
  ) {
    this.configValues = config.get();
    this.maxConcurrent = this.configValues.workerConcurrency;
  }

  async start(): Promise<void> {
    this.browser = await puppeteer.launch({ headless: true });
    console.log('Worker started. Waiting for render tasks...');
    await this.rabbit.consumeRequests(async (task) => {
      return this.enqueueTask(task);
    });
  }

  private enqueueTask(task: RenderTask): Promise<void> {
    return new Promise((resolve, reject) => {
      this.queue.push({ task, resolve, reject });
      this.processQueue();
    });
  }

  private processQueue(): void {
    if (!this.browser) {
      return;
    }
    while (this.active < this.maxConcurrent && this.queue.length > 0) {
      const entry = this.queue.shift();
      if (!entry) {
        break;
      }
      this.active += 1;
      this.handleTask(entry.task)
        .then(entry.resolve)
        .catch(entry.reject)
        .finally(() => {
          this.active -= 1;
          this.processQueue();
        });
    }
  }

  private async handleTask(task: RenderTask): Promise<void> {
    try {
      const html = await this.render(task.url);
      const outputPath = await this.saveToDisk(task.url, html);
      await this.cache.setUrl(task.url, outputPath);
      await this.rabbit.respond(task.queueId, { path: outputPath });
      console.log(`Rendered and cached ${task.url}`);
    } catch (error) {
      console.error(`Failed to render ${task.url}`, error);
      await this.rabbit.respond(task.queueId, {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  private async render(url: string): Promise<string> {
    if (!this.browser) {
      throw new Error('Browser is not initialized');
    }
    const page = await this.browser.newPage();
    try {
      await page.goto(url, { waitUntil: 'networkidle0', timeout: 60_000 });
      return page.content();
    } finally {
      await page.close();
    }
  }

  private async saveToDisk(url: string, html: string): Promise<string> {
    const config = this.configValues;
    const sanitized = url.replace(/[^a-z0-9]/gi, '_').toLowerCase();
    const filename = `${sanitized}_${Date.now()}.html`;
    const outputPath = path.join(config.outputDir, filename);
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, html, 'utf8');
    return outputPath;
  }

  async shutdown(): Promise<void> {
    await this.browser?.close();
  }
}

const worker = container.resolve(Worker);
worker.start().catch((error) => {
  console.error('Worker failed', error);
  process.exit(1);
});
