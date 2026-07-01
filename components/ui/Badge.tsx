type Variant = "owner" | "editor" | "comingSoon" | "success" | "warning" | "danger" | "neutral";

interface Props {
  variant: Variant;
  children: React.ReactNode;
  className?: string;
}

const VARIANT_CLASSES: Record<Variant, string> = {
  owner: "bg-green-100 text-green-700 font-semibold",
  editor: "bg-gray-100 text-gray-600 font-semibold",
  comingSoon: "bg-gray-100 text-gray-500 font-medium",
  success: "bg-green-100 text-green-700 font-semibold",
  warning: "bg-yellow-100 text-yellow-700 font-semibold",
  danger: "bg-red-100 text-red-700 font-semibold",
  neutral: "bg-gray-100 text-gray-600 font-semibold",
};

export function Badge({ variant, children, className }: Props) {
  return (
    <span
      className={[
        "inline-block rounded-full px-2.5 py-0.5 text-xs",
        VARIANT_CLASSES[variant],
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {children}
    </span>
  );
}
