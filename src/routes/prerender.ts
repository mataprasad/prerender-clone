import fs from 'fs/promises';
import path from 'path';
import type { Express, Request, Response } from 'express';
import { singleton } from 'tsyringe';
import { CacheService } from '../cache.js';
import { RabbitClient } from '../rabbit.js';
import { ConfigService } from '../config.js';
import { logger } from '../logger.js';

@singleton()
export class PrerenderRoute {
  constructor(
    private readonly cache: CacheService,
    private readonly rabbit: RabbitClient,
    private readonly configService: ConfigService,
  ) {
    this.handleRequest = this.handleRequest.bind(this);
  }

  register(app: Express): void {
    app.get('/prerender', this.handleRequest);
  }

  private async handleRequest(req: Request, res: Response): Promise<void> {
    const config = this.configService.get();
    const targetUrl = req.query.url;
    if (!targetUrl || typeof targetUrl !== 'string') {
      res.status(400).json({ error: 'Missing url query parameter' });
      return;
    }
    logger.info(
      {
        url: targetUrl,
        requestId: (req as any).id,
      },
      'Received prerender request',
    );

    try {
      const cachedPath = await this.cache.getUrl(targetUrl);
      if (cachedPath) {
        logger.info({ url: targetUrl, cachedPath }, 'Cache hit');
        const html = await this.readHtmlFromPath(cachedPath, config.outputDir);
        if (html !== null) {
          res.type('html').send(html);
          return;
        }
      }

      const renderResult = await this.rabbit.requestRender(targetUrl);
      logger.info({ url: targetUrl, response: renderResult }, 'Received render response');

      if (!renderResult || renderResult.error) {
        const message = renderResult?.error || 'Failed to prerender the requested page';
        res.status(502).json({ error: message });
        return;
      }

      const filePath = renderResult.path;
      if (!filePath) {
        res.status(502).json({ error: 'Renderer did not return a file path' });
        return;
      }

      await this.cache.setUrl(targetUrl, filePath);

      const html = await this.readHtmlFromPath(filePath, config.outputDir);
      if (html === null) {
        res.status(502).json({ error: 'Rendered file not found on disk' });
        return;
      }

      res.type('html').send(html);
    } catch (error) {
      logger.error({ url: targetUrl, error }, 'Route request failed');
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  private async readHtmlFromPath(
    storedPath: string,
    outputDir: string,
  ): Promise<string | null> {
    const normalized = this.normalizePath(storedPath, outputDir);
    if (!normalized) {
        logger.warn({ storedPath }, 'Invalid cached path skipped');
      return null;
    }

    try {
      return await fs.readFile(normalized, 'utf8');
    } catch (error) {
      logger.warn({ normalized, error }, 'Unable to read cached file');
      return null;
    }
  }

  private normalizePath(candidate: string, outputDir: string): string | null {
    if (!candidate) {
      return null;
    }

    const baseDir = outputDir || path.join(process.cwd(), 'dist');
    const resolved = path.isAbsolute(candidate)
      ? candidate
      : path.join(baseDir, candidate);

    const normalized = path.normalize(resolved);
    if (!normalized.startsWith(path.normalize(baseDir))) {
      return null;
    }

    return normalized;
  }
}
