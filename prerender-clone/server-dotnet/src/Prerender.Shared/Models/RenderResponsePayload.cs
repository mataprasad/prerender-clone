namespace Prerender.Shared.Models;

public sealed class RenderResponsePayload
{
    public string? Path { get; init; }
    public string? Error { get; init; }
    public string CorrelationId { get; init; } = "";
}
