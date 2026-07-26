import type { ReactNode } from "react";

export function PageFrame({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="console-page">
      <header className="console-page-head">
        <div>
          <h1>{title}</h1>
          <p>{description}</p>
        </div>
        {actions ? <div className="console-actions">{actions}</div> : null}
      </header>
      {children}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="console-empty">
      <h2>{title}</h2>
      <p>{description}</p>
      {action}
    </div>
  );
}
