type Variant = "default" | "hover";

interface Props {
  variant?: Variant;
  className?: string;
  children: React.ReactNode;
}

// §6.4: surface + hairline border, radius 6, no shadow at rest.
// Interactive cards get border-strong + shadow-sm on hover.
const VARIANT_CLASSES: Record<Variant, string> = {
  default: "",
  hover: "transition-all duration-fast hover:border-border-strong hover:shadow-sm",
};

export function Card({ variant = "default", className, children }: Props) {
  return (
    <div
      className={[
        "rounded-card border-border bg-surface border",
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
