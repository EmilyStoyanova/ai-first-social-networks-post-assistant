interface Props {
  children: React.ReactNode;
  className?: string;
}

export function Container({ children, className }: Props) {
  return <div className={["w-full", className ?? ""].filter(Boolean).join(" ")}>{children}</div>;
}
