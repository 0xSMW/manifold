"use client";

import { useCallback } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Select } from "@/components/ui/field";

export const telemetryRanges = ["1h", "24h", "7d", "30d"] as const;
export type TelemetryRange = (typeof telemetryRanges)[number];
export type TelemetryProfile = "public_app" | "enterprise_egress";

const telemetryPaths = new Set(["/", "/logs", "/usage"]);

export function isTelemetryPath(pathname: string) {
  return telemetryPaths.has(pathname);
}

export function telemetryHref(href: string, range: TelemetryRange, profile: TelemetryProfile) {
  if (!isTelemetryPath(href)) return href;
  const params = new URLSearchParams({ range, profile });
  return `${href}?${params.toString()}`;
}

export function useTelemetryFilters() {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const candidateRange = searchParams.get("range");
  const candidateProfile = searchParams.get("profile");
  const range: TelemetryRange = telemetryRanges.includes(candidateRange as TelemetryRange) ? candidateRange as TelemetryRange : "24h";
  const profile: TelemetryProfile = candidateProfile === "enterprise_egress" ? "enterprise_egress" : "public_app";

  const setTelemetryFilters = useCallback((next: Partial<{ range: TelemetryRange; profile: TelemetryProfile }>) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set("range", next.range ?? range);
    params.set("profile", next.profile ?? profile);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  }, [pathname, profile, range, router, searchParams]);

  return { profile, range, setTelemetryFilters };
}

export function TelemetryFilterControls({ profile, range, onChange }: {
  profile: TelemetryProfile;
  range: TelemetryRange;
  onChange: (next: Partial<{ range: TelemetryRange; profile: TelemetryProfile }>) => void;
}) {
  return <div aria-label="Global telemetry filters" style={{ alignItems: "center", display: "flex", flexWrap: "wrap", gap: 8 }}>
    <label className="console-field" style={{ minWidth: 132 }}><span>Time range</span><Select aria-label="Time range" onChange={(event) => onChange({ range: event.target.value as TelemetryRange })} value={range}>{telemetryRanges.map((item) => <option key={item} value={item}>{item === "1h" ? "Last hour" : `Last ${item}`}</option>)}</Select></label>
    <label className="console-field" style={{ minWidth: 170 }}><span>Profile</span><Select aria-label="Telemetry profile" onChange={(event) => onChange({ profile: event.target.value as TelemetryProfile })} value={profile}><option value="public_app">public_app</option><option value="enterprise_egress">enterprise_egress</option></Select></label>
  </div>;
}
