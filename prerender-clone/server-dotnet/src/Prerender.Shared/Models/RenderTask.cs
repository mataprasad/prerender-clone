namespace Prerender.Shared.Models;

public sealed class RenderTask
{
    public string Url { get; init; } = "";
    public string QueueId { get; init; } = "";
    public string RequestedAt { get; init; } = "";
    public string CorrelationId { get; init; } = "";
}
