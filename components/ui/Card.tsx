type Variant = "default" | "hover";

interface Props {
  variant?: Variant;
  className?: string;
  children: React.ReactNode;
}

const VARIANT_CLASSES: Record<Variant, string> = {
  default: "",
  hover: "transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md",
};

export function Card({ variant = "default", className, children }: Props) {
  return (
    <div
      className={[
        "rounded-2xl border border-gray-200 bg-white shadow-sm",
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
