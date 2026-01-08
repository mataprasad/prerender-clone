using System;
using System.Threading.Tasks;
using Microsoft.Extensions.Logging;
using StackExchange.Redis;

namespace Prerender.Shared;

public sealed class CacheService : IAsyncDisposable
{
    private readonly AppConfig _config;
    private readonly ILogger<CacheService> _logger;
    private readonly ConnectionMultiplexer _redis;
    private readonly IDatabase _db;

    public CacheService(ConfigService configService, ILogger<CacheService> logger)
    {
        _config = configService.Get();
        _logger = logger;
        _redis = ConnectionMultiplexer.Connect(_config.RedisUrl);
        _db = _redis.GetDatabase();
    }

    public async Task<string?> GetUrlAsync(string url)
    {
        var key = _config.CachePrefix + url;
        var value = await _db.StringGetAsync(key);
        if (value.IsNullOrEmpty)
        {
            return null;
        }
        return value.ToString();
    }

    public Task SetUrlAsync(string url, string path)
    {
        var key = _config.CachePrefix + url;
        return _db.StringSetAsync(key, path, TimeSpan.FromSeconds(_config.CacheTtlSeconds));
    }

    public async ValueTask DisposeAsync()
    {
        _logger.LogInformation("Closing redis connection");
        await _redis.CloseAsync();
    }
}
