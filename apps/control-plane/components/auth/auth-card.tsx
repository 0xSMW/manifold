import type { ReactNode } from "react";
import { Card } from "@/components/ui/card";

export function AuthCard({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return <main className="auth-page"><Card className="auth-card"><header><a className="auth-brand" href="/">Manifold</a><h1>{title}</h1><p>{description}</p></header>{children}</Card></main>;
}

export function AuthNotice({ children, tone = "error" }: { children: ReactNode; tone?: "error" | "success" }) {
  return <p className={`auth-notice auth-notice-${tone}`} role={tone === "error" ? "alert" : "status"}>{children}</p>;
}

export function safeNext(value: string | null): string {
  return value && value.startsWith("/") && !value.startsWith("//") ? value : "/";
}
