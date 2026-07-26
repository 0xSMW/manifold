"use client";

import { PageFrame } from "@/components/console/page-frame";
import { SessionsPanel } from "@/components/settings/human-auth-panels";

export function AccountConsole() {
  return <PageFrame description="Manage your signed-in browser sessions." title="Account"><SessionsPanel /></PageFrame>;
}
