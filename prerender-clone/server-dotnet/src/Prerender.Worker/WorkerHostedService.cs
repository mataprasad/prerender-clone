using System;
using System.IO;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using PuppeteerSharp;
using Prerender.Shared;
using Prerender.Shared.Models;

namespace Prerender.Worker;

public sealed class WorkerHostedService(
    RabbitClient rabbit,
    CacheService cache,
    ConfigService configService,
    ILogger<WorkerHostedService> logger)
    : BackgroundService
{
    private readonly SemaphoreSlim _semaphore = new(configService.Get().WorkerConcurrency);

    private IBrowser? _browser;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var config = configService.Get();
        var options = new LaunchOptions
        {
            Headless = true,
            Args = new[] { "--no-sandbox", "--disable-setuid-sandbox" },
        };

        var executablePath = Environment.GetEnvironmentVariable("PUPPETEER_EXECUTABLE_PATH");
        if (!string.IsNullOrWhiteSpace(executablePath))
        {
            options.ExecutablePath = executablePath;
        }
        else
        {
            var cacheDir = Environment.GetEnvironmentVariable("PUPPETEER_CACHE_DIR");
            if (string.IsNullOrWhiteSpace(cacheDir))
            {
                cacheDir = Path.Combine(AppContext.BaseDirectory, ".cache", "puppeteer");
            }

            var browserFetcher = new BrowserFetcher(new BrowserFetcherOptions
            {
                Path = cacheDir,
            });
            var revisionInfo = await browserFetcher.DownloadAsync();
            options.ExecutablePath = revisionInfo.GetExecutablePath();
        }

        _browser = await Puppeteer.LaunchAsync(options);
        logger.LogInformation("Worker started. Concurrency {Concurrency}", config.WorkerConcurrency);

        await rabbit.ConsumeRequestsAsync(async task =>
        {
            await _semaphore.WaitAsync(stoppingToken);
            try
            {
                await HandleTaskAsync(task, stoppingToken);
            }
            finally
            {
                _semaphore.Release();
            }
        }, prefetchCount: (ushort)Math.Max(config.WorkerConcurrency, 1));

        await Task.Delay(Timeout.Infinite, stoppingToken);
    }

    private async Task HandleTaskAsync(RenderTask task, CancellationToken stoppingToken)
    {
        if (_browser == null)
        {
            throw new InvalidOperationException("Browser is not initialized");
        }

        try
        {
            logger.LogInformation("Begin rendering {Url} {QueueId}", task.Url, task.QueueId);
            var html = await RenderAsync(task.Url, stoppingToken);
            var outputPath = await SaveToDiskAsync(task.Url, html, stoppingToken);
            await cache.SetUrlAsync(task.Url, outputPath);
            await rabbit.RespondAsync(task.QueueId, new RenderResponsePayload
            {
                Path = outputPath,
                CorrelationId = task.CorrelationId,
            });
            logger.LogInformation("Completed rendering {Url} -> {Path}", task.Url, outputPath);
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Failed to render {Url}", task.Url);
            await rabbit.RespondAsync(task.QueueId, new RenderResponsePayload
            {
                CorrelationId = task.CorrelationId,
                Error = ex.Message,
            });
        }
    }

    private async Task<string> RenderAsync(string url, CancellationToken stoppingToken)
    {
        if (_browser == null)
        {
            throw new InvalidOperationException("Browser is not initialized");
        }

        await using var page = await _browser.NewPageAsync();
        try
        {
            await page.GoToAsync(url);
            await page.WaitForNetworkIdleAsync(new WaitForNetworkIdleOptions
            {
                Timeout = 60_000,
            });
            return await page.GetContentAsync();
        }
        finally { }
    }

    private async Task<string> SaveToDiskAsync(string url, string html, CancellationToken stoppingToken)
    {
        var config = configService.Get();
        var sanitized = Regex.Replace(url, "[^a-zA-Z0-9]", "_").ToLowerInvariant();
        var filename = $"{sanitized}_{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}.html";
        var outputPath = Path.Combine(config.OutputDir, filename);

        Directory.CreateDirectory(Path.GetDirectoryName(outputPath)!);
        await File.WriteAllTextAsync(outputPath, html, stoppingToken);
        return outputPath;
    }

    public override async Task StopAsync(CancellationToken cancellationToken)
    {
        await base.StopAsync(cancellationToken);
        if (_browser != null)
        {
            await _browser.CloseAsync();
            _browser = null;
        }

    }
}
