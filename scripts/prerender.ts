import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer, { type PuppeteerLifeCycleEvent } from 'puppeteer';

const __filename = fileURLToPath(import.meta.url);

interface ParsedArgs {
  url: string;
  output?: string;
  waitUntil: PuppeteerLifeCycleEvent;
}

export class PrerenderCommand {
  private readonly argv: string[];

  private readonly usage: string;

  constructor(argv: string[] = process.argv) {
    this.argv = argv;
    this.usage = `
Usage:
  npm run render -- <url> [--output <file>] [--wait-until <event>]

Examples:
  npm run render -- https://example.com
  npm run render -- https://example.com --output dist/example.html
`.trim();
  }

  private parseArgs(): ParsedArgs {
    const args = this.argv.slice(2);
    const parsed: Partial<ParsedArgs> & { help?: boolean } = {};

    for (let i = 0; i < args.length; i += 1) {
      const arg = args[i];
      switch (arg) {
        case '--help':
        case '-h':
          parsed.help = true;
          break;
        case '--output':
        case '-o':
          parsed.output = args[++i];
          break;
        case '--wait-until':
          parsed.waitUntil = args[++i] as PuppeteerLifeCycleEvent;
          break;
        default:
          if (!parsed.url) {
            parsed.url = arg;
          } else {
            throw new Error(`Unexpected argument: ${arg}`);
          }
      }
    }

    if (parsed.help) {
      this.printUsage();
      process.exit(0);
    }

    if (!parsed.url) {
      throw new Error('URL is required\n\n' + this.usage);
    }

    return {
      url: parsed.url,
      output: parsed.output,
      waitUntil: parsed.waitUntil || 'networkidle0',
    };
  }

  private printUsage(): void {
    console.log(this.usage);
  }

  async run(): Promise<void> {
    try {
      const args = this.parseArgs();
      const html = await this.renderPage(args.url, args.waitUntil);
      if (args.output) {
        await this.writeOutput(html, args.output);
      } else {
        process.stdout.write(html);
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown error occurred';
      console.error(message);
      process.exit(1);
    }
  }

  private async renderPage(
    url: string,
    waitUntil: PuppeteerLifeCycleEvent,
  ): Promise<string> {
    const browser = await puppeteer.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.goto(url, { waitUntil, timeout: 60_000 });
      return page.content();
    } finally {
      await browser.close();
    }
  }

  private async writeOutput(html: string, targetPath: string): Promise<void> {
    const outputPath = path.isAbsolute(targetPath)
      ? targetPath
      : path.join(process.cwd(), targetPath);
    await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.promises.writeFile(outputPath, html, 'utf8');
    console.log(`Saved prerendered HTML to ${outputPath}`);
  }
}

if (import.meta.url === `file://${__filename}`) {
  const command = new PrerenderCommand();
  command.run();
}
