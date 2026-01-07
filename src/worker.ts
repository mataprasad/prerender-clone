import 'reflect-metadata';
import fs from 'fs/promises';
import path from 'path';
import puppeteer from 'puppeteer';
import { container, singleton } from 'tsyringe';
import dotenv from 'dotenv';
import { RabbitClient, type RenderResponsePayload } from './rabbit.js';
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
  constructor(
    private readonly rabbit: RabbitClient,
    private readonly cache: CacheService,
    private readonly config: ConfigService,
  ) {}

  async start(): Promise<void> {
    console.log('Worker started. Waiting for render tasks...');
    await this.rabbit.consumeRequests(async (task) => {
      await this.handleTask(task);
    });
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
    const browser = await puppeteer.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.goto(url, { waitUntil: 'networkidle0', timeout: 60_000 });
      return page.content();
    } finally {
      await browser.close();
    }
  }

  private async saveToDisk(url: string, html: string): Promise<string> {
    const config = this.config.get();
    const sanitized = url.replace(/[^a-z0-9]/gi, '_').toLowerCase();
    const filename = `${sanitized}_${Date.now()}.html`;
    const outputPath = path.join(config.outputDir, filename);
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, html, 'utf8');
    return outputPath;
  }
}

const worker = container.resolve(Worker);
worker.start().catch((error) => {
  console.error('Worker failed', error);
  process.exit(1);
});
