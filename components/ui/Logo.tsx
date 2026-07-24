/**
 * The "New Post" wordmark.
 *
 * Rendered entirely in code (no raster asset) so it stays crisp at any size and
 * adapts to light/dark themes. Three visual layers recreate the source artwork:
 *   1. an outlined pink "echo" offset up-left behind the wordmark,
 *   2. the solid pink wordmark itself,
 *   3. a hard (blur-free) gray drop shadow offset down-right.
 *
 * All offsets are expressed in `em`, so the whole effect scales with the chosen
 * `size` (font-size) with no per-size tuning.
 */

type LogoSize = "sm" | "md" | "lg";

interface LogoProps {
  size?: LogoSize;
  className?: string;
}

const SIZE_CLASSES: Record<LogoSize, string> = {
  sm: "text-xl",
  md: "text-3xl",
  lg: "text-4xl",
};

const PINK = "#F5308B";

export function Logo({ size = "md", className = "" }: LogoProps) {
  return (
    <span
      className={[
        "relative inline-block leading-none font-extrabold tracking-tight whitespace-nowrap select-none",
        SIZE_CLASSES[size],
        className,
      ].join(" ")}
    >
      {/* Outlined echo layer behind the wordmark */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{
          color: "transparent",
          WebkitTextStroke: `0.03em ${PINK}`,
          opacity: 0.35,
          transform: "translate(-0.05em, -0.05em)",
        }}
      >
        New Post
      </span>
      {/* Solid wordmark with a hard gray offset shadow */}
      <span
        className="relative"
        style={{ color: PINK, textShadow: "0.06em 0.06em 0 rgba(130,130,130,0.5)" }}
      >
        New Post
      </span>
    </span>
  );
}
