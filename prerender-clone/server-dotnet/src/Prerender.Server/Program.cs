using System;
using System.IO;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Prerender.Shared;

dotenv.net.DotEnv.Load();

var builder = WebApplication.CreateBuilder(args);

builder.Logging.ClearProviders();
builder.Logging.AddSimpleConsole(options =>
{
    options.IncludeScopes = true;
    options.SingleLine = true;
    options.TimestampFormat = "HH:mm:ss ";
});

var configService = new ConfigService();
var appConfig = configService.Get();

builder.Services.AddSingleton(configService);
builder.Services.AddSingleton<CacheService>();
builder.Services.AddSingleton<RabbitClient>();

builder.WebHost.UseUrls($"http://0.0.0.0:{appConfig.Port}");

var app = builder.Build();

app.MapGet("/healthz", () => Results.Ok(new { status = "ok" }));

app.MapGet("/prerender", async (
    HttpRequest request,
    CacheService cache,
    RabbitClient rabbit,
    ConfigService config,
    ILoggerFactory loggerFactory) =>
{
    var logger = loggerFactory.CreateLogger("PrerenderRoute");
    var targetUrl = request.Query["url"].ToString();

    if (string.IsNullOrWhiteSpace(targetUrl))
    {
        return Results.BadRequest(new { error = "Missing url query parameter" });
    }

    logger.LogInformation("Received prerender request {Url} {RequestId}", targetUrl, request.HttpContext.TraceIdentifier);

    try
    {
        var cachedPath = await cache.GetUrlAsync(targetUrl);
        if (!string.IsNullOrWhiteSpace(cachedPath))
        {
            logger.LogInformation("Cache hit {Url} -> {Path}", targetUrl, cachedPath);
            var html = await ReadHtmlFromPathAsync(cachedPath, config.Get().OutputDir, logger);
            if (html != null)
            {
                return Results.Text(html, "text/html");
            }
        }

        var response = await rabbit.RequestRenderAsync(targetUrl, request.HttpContext.RequestAborted);
        logger.LogInformation("Received render response {Url}", targetUrl);

        if (!string.IsNullOrWhiteSpace(response.Error))
        {
            return Results.Problem(response.Error, statusCode: StatusCodes.Status502BadGateway);
        }

        if (string.IsNullOrWhiteSpace(response.Path))
        {
            return Results.Problem("Renderer did not return a file path", statusCode: StatusCodes.Status502BadGateway);
        }

        await cache.SetUrlAsync(targetUrl, response.Path);

        var renderedHtml = await ReadHtmlFromPathAsync(response.Path, config.Get().OutputDir, logger);
        if (renderedHtml == null)
        {
            return Results.Problem("Rendered file not found on disk", statusCode: StatusCodes.Status502BadGateway);
        }

        return Results.Text(renderedHtml, "text/html");
    }
    catch (Exception ex)
    {
        logger.LogError(ex, "Prerender request failed {Url}", targetUrl);
        return Results.Problem("Internal server error", statusCode: StatusCodes.Status500InternalServerError);
    }
});

await app.RunAsync();

static async Task<string?> ReadHtmlFromPathAsync(string storedPath, string outputDir, ILogger logger)
{
    var normalized = NormalizePath(storedPath, outputDir);
    if (normalized == null)
    {
        logger.LogWarning("Invalid cached path skipped {Path}", storedPath);
        return null;
    }

    try
    {
        return await File.ReadAllTextAsync(normalized);
    }
    catch (Exception ex)
    {
        logger.LogWarning(ex, "Unable to read cached file {Path}", normalized);
        return null;
    }
}

static string? NormalizePath(string candidate, string outputDir)
{
    if (string.IsNullOrWhiteSpace(candidate))
    {
        return null;
    }

    var baseDir = string.IsNullOrWhiteSpace(outputDir)
        ? AppConfig.DefaultOutputDir()
        : outputDir;

    if (!Path.IsPathRooted(baseDir))
    {
        baseDir = Path.Combine(Directory.GetCurrentDirectory(), baseDir);
    }

    baseDir = Path.GetFullPath(baseDir);

    var resolved = Path.IsPathRooted(candidate)
        ? candidate
        : Path.Combine(baseDir, candidate);

    var fullPath = Path.GetFullPath(resolved);
    var comparison = OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;

    if (!fullPath.StartsWith(baseDir + Path.DirectorySeparatorChar, comparison) &&
        !string.Equals(fullPath, baseDir, comparison))
    {
        return null;
    }

    return fullPath;
}
