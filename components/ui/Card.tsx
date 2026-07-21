type Variant = "default" | "hover";

interface Props {
  variant?: Variant;
  className?: string;
  children: React.ReactNode;
}

// §6.4 (v2.2): surface + hairline border, radius 14, resting shadow-card.
// Interactive cards lift to border-strong + shadow-sm on hover.
const VARIANT_CLASSES: Record<Variant, string> = {
  default: "",
  hover: "transition-all duration-fast hover:border-border-strong hover:shadow-sm",
};

export function Card({ variant = "default", className, children }: Props) {
  return (
    <div
      className={[
        "rounded-card border-border bg-surface shadow-card border",
        VARIANT_CLASSES[variant],
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {children}
    </div>
  );
}
