export type WorkspaceProfile = "public_app" | "enterprise_egress";
export type MemberRole = "owner" | "admin" | "editor" | "viewer" | "billing";
export type ShellNavItem = { label: string; href: string; minRole?: MemberRole; enterpriseOnly?: boolean; keywords?: string };
export type ShellNavGroup = { label?: string; items: ShellNavItem[] };
export type AppShellProps = {
  children: React.ReactNode;
  user: { name: string; email?: string; initials?: string; role: MemberRole };
  workspace: { name: string; slug?: string };
  profile: WorkspaceProfile;
  profiles: WorkspaceProfile[];
  pendingChanges?: number;
  nav?: ShellNavGroup[];
  onProfileChange?: (profile: WorkspaceProfile) => void;
  onLogout?: () => void | Promise<void>;
  loggingOut?: boolean;
  logoutError?: string | null;
  telemetrySearch?: { range: "1h" | "24h" | "7d" | "30d"; profile: WorkspaceProfile };
};
