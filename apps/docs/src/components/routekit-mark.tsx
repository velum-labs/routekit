import Image from "next/image";

type RouteKitMarkProps = {
  readonly compact?: boolean;
  readonly label?: string;
  readonly surface?: "adaptive" | "dark" | "light";
  readonly variant?: "inline" | "stacked";
};

export function RouteKitMark({
  compact = false,
  label = "RouteKit",
  surface = "adaptive",
  variant = "inline"
}: RouteKitMarkProps) {
  return (
    <span
      className={`routekit-brand routekit-brand-${surface} routekit-brand-${variant}`}
      aria-label={label}
    >
      <span className="routekit-logo-frame" aria-hidden="true">
        <Image
          alt=""
          className="routekit-logo routekit-logo-dark-surface"
          height={512}
          priority
          src="/routekit-logo-dark.png"
          width={512}
        />
        <Image
          alt=""
          className="routekit-logo routekit-logo-light-surface"
          height={512}
          priority
          src="/routekit-logo-light.png"
          width={512}
        />
      </span>
      {!compact &&
        (variant === "stacked" ? (
          <span className="routekit-lockup">
            <span className="routekit-wordmark">RouteKit</span>
            <span className="routekit-byline">by Velum Labs</span>
          </span>
        ) : (
          <span className="routekit-wordmark">RouteKit</span>
        ))}
    </span>
  );
}
