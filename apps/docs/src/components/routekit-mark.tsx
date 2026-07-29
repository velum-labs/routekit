export function RouteKitMark({
  compact = false,
  label = "RouteKit"
}: {
  readonly compact?: boolean;
  readonly label?: string;
}) {
  return (
    <span className="routekit-brand" aria-label={label}>
      <svg aria-hidden="true" className="routekit-mark" viewBox="0 0 24 24" fill="none">
        <rect width="24" height="24" fill="#8b5cf6" />
        <path d="M4 12h6M10 12l6-6h4M10 12h10M10 12l6 6h4" stroke="white" strokeWidth="1.6" />
        <circle cx="4.5" cy="12" r="1.8" fill="white" />
      </svg>
      {!compact && (
        <span className="routekit-wordmark">
          Route<span>Kit</span>
        </span>
      )}
    </span>
  );
}
