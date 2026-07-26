export type Status = "up" | "verifying" | "down" | "idle";
export function StatusDot({ status, label }: { status: Status; label?: string }) { return <span aria-label={label ?? status} className="cp-status-dot" data-status={status} role="img" />; }
export function StatusBadge({ status, children }: { status: Status; children: React.ReactNode }) { return <span className="cp-status-badge" data-status={status}><StatusDot status={status} />{children}</span>; }
