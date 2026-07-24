/**
 * The "New Post" logo — a line-art megaphone.
 *
 * Rendered as inline SVG (no raster asset) so it stays crisp at any size and on
 * either theme. The same artwork is served as the browser-tab icon from
 * `app/icon.svg`; keep the two in sync if the shape changes.
 */

type LogoSize = "sm" | "md" | "lg";

interface LogoProps {
  size?: LogoSize;
  className?: string;
}

/** Icon pixel size and white-chip padding/radius per variant. */
const SIZE: Record<LogoSize, { icon: number; pad: string; radius: string }> = {
  sm: { icon: 26, pad: "p-1.5", radius: "rounded-lg" },
  md: { icon: 40, pad: "p-2", radius: "rounded-xl" },
  lg: { icon: 56, pad: "p-2.5", radius: "rounded-xl" },
};

const PINK = "#F5308B";

export function Logo({ size = "md", className = "" }: LogoProps) {
  const { icon, pad, radius } = SIZE[size];
  return (
    <span
      className={[
        "inline-flex shrink-0 items-center justify-center bg-white ring-1 ring-black/5 shadow-sm",
        pad,
        radius,
        className,
      ].join(" ")}
    >
      <svg
        role="img"
        aria-label="New Post"
        width={icon}
        height={icon}
        viewBox="0 0 100 100"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <g stroke={PINK} strokeWidth={5} strokeLinecap="round" strokeLinejoin="round">
          {/* Bell — outer rim and inner mouth */}
          <ellipse cx="66" cy="50" rx="11" ry="25" />
          <ellipse cx="66" cy="50" rx="5.5" ry="15" />
          {/* Cone body tapering to the mouthpiece */}
          <path d="M60 27 L27 42 C23 43 23 57 27 58 L60 73" />
          {/* Rings near the mouthpiece */}
          <path d="M31 44 L31 56" />
          <path d="M37 44.5 L37 55.5" />
          {/* Handle */}
          <path d="M42 57 L42 79 C42 83 50 83 50 79 L50 61" />
          {/* Sound lines */}
          <path d="M83 31 L94 25" />
          <path d="M86 49 L99 48" />
          <path d="M83 67 L94 73" />
        </g>
      </svg>
    </span>
  );
}
