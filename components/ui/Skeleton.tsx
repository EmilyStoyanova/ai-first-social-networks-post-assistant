type Variant = "line" | "card" | "tile" | "row";

interface Props {
  variant?: Variant;
  count?: number;
  className?: string;
}

// §6.6: skeletons mirror the final layout. Shimmer respects prefers-reduced-motion
// via the global media query (animation collapses to static).
const VARIANT_CLASSES: Record<Variant, string> = {
  line: "h-4 w-full rounded-control",
  card: "h-32 w-full rounded-card",
  tile: "aspect-square w-full rounded-card",
  row: "h-12 w-full rounded-control",
};

export function Skeleton({ variant = "line", count = 1, className }: Props) {
  return (
    <div className="space-y-2" aria-hidden="true">
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          className={["bg-surface-subtle animate-pulse", VARIANT_CLASSES[variant], className ?? ""]
            .filter(Boolean)
            .join(" ")}
        />
      ))}
    </div>
  );
}
