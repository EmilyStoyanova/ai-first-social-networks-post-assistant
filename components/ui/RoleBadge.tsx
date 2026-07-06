import { Badge } from "./Badge";

export type RoleValue = "owner" | "editor" | "admin";

interface Props {
  role: RoleValue;
  /** Translated label — callers pass the localized role name. */
  label: string;
  className?: string;
}

const ROLE_VARIANT: Record<RoleValue, "owner" | "editor" | "neutral"> = {
  owner: "owner",
  editor: "editor",
  admin: "neutral",
};

export function RoleBadge({ role, label, className }: Props) {
  return (
    <Badge variant={ROLE_VARIANT[role]} className={className}>
      {label}
    </Badge>
  );
}
