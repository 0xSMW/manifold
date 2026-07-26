"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { AppShell } from "@/components/shell/app-shell";
import type { MemberRole, WorkspaceProfile } from "@/components/shell/types";
import { isTelemetryPath } from "@/components/telemetry/telemetry-filters";
import { AlertBanner } from "@/components/ui/alert";
import { apiRequest, ControlPlaneApiError } from "@/lib/api-client";

interface MeResponse {
  member: { id: string; email: string; name: string | null; role: MemberRole } | null;
  role: MemberRole | null;
  workspace: { id: string; slug: string; name: string; region: string } | null;
  scopes: string[];
  availableIngressProfiles: Array<{
    id: string;
    installationId: string;
    mode: WorkspaceProfile;
  }>;
}

interface ConfigPlan {
  diff: unknown;
  noop: boolean;
}

const roleRank: Record<MemberRole, number> = {
  billing: -1,
  viewer: 0,
  editor: 1,
  admin: 2,
  owner: 3,
};

function countChanges(value: unknown): number {
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + countChanges(item), 0);
  if (!value || typeof value !== "object") return 0;
  return Object.values(value).reduce<number>((sum, item) => {
    if (Array.isArray(item)) return sum + item.length;
    return sum + countChanges(item);
  }, 0);
}

export function ConsoleGate({
  children,
  minRole = "viewer",
  enterpriseOnly = false,
}: {
  children: ReactNode;
  minRole?: MemberRole;
  enterpriseOnly?: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [me, setMe] = useState<MeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [profile, setProfile] = useState<WorkspaceProfile>("public_app");
  const [pendingChanges, setPendingChanges] = useState(0);
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);

  useEffect(() => {
    let active = true;
    apiRequest<MeResponse>("/me")
      .then(async (result) => {
        if (!active) return;
        if (!result.member || !result.workspace) {
          router.replace("/login");
          return;
        }
        const modes = [...new Set(result.availableIngressProfiles.map((item) => item.mode))];
        const stored = window.localStorage.getItem("manifold-profile") as WorkspaceProfile | null;
        const requested = searchParams.get("profile") as WorkspaceProfile | null;
        const selected = requested && modes.includes(requested) ? requested : stored && modes.includes(stored) ? stored : (modes[0] ?? "public_app");
        setProfile(selected);
        setMe(result);
      })
      .catch((caught: unknown) => {
        if (!active) return;
        if (caught instanceof ControlPlaneApiError && caught.status === 401) {
          router.replace(`/login?next=${encodeURIComponent(pathname)}`);
          return;
        }
        setError(caught instanceof Error ? caught.message : "Unable to load console");
      });
    return () => {
      active = false;
    };
  }, [pathname, router, searchParams]);

  const profiles = useMemo(
    () => [...new Set(me?.availableIngressProfiles.map((item) => item.mode) ?? [])],
    [me],
  );

  useEffect(() => {
    if (!me?.scopes.includes("config:read")) {
      setPendingChanges(0);
      return;
    }
    const installationId = me.availableIngressProfiles.find(
      (item) => item.mode === profile,
    )?.installationId;
    if (!installationId) {
      setPendingChanges(0);
      return;
    }
    let active = true;
    apiRequest<ConfigPlan>("/config/plan", {
      method: "POST",
      body: { installationId },
    })
      .then((plan) => {
        if (active) setPendingChanges(plan.noop ? 0 : Math.max(1, countChanges(plan.diff)));
      })
      .catch(() => {
        if (active) setPendingChanges(0);
      });
    return () => {
      active = false;
    };
  }, [me, profile]);

  useEffect(() => {
    if (me && enterpriseOnly && !profiles.includes("enterprise_egress")) {
      router.replace("/");
    }
  }, [enterpriseOnly, me, profiles, router]);

  if (error) {
    return (
      <div className="console-loading">
        <AlertBanner tone="down" title="Console unavailable">{error}</AlertBanner>
      </div>
    );
  }
  if (!me?.member || !me.workspace) {
    return (
      <div className="console-loading" aria-busy="true">
        <span className="cp-status-dot" data-status="verifying" />
        <span className="console-muted">Loading console</span>
      </div>
    );
  }
  if (roleRank[me.member.role] < roleRank[minRole]) {
    return (
      <div className="console-loading">
        <AlertBanner tone="down" title="Permission denied">
          This page requires the {minRole} role
        </AlertBanner>
      </div>
    );
  }
  if (enterpriseOnly && !profiles.includes("enterprise_egress")) {
    return null;
  }

  const selectProfile = (next: WorkspaceProfile) => {
    window.localStorage.setItem("manifold-profile", next);
    setProfile(next);
    if (isTelemetryPath(pathname)) {
      const params = new URLSearchParams(searchParams.toString());
      params.set("profile", next);
      params.set("range", params.get("range") ?? "24h");
      router.replace(`${pathname}?${params.toString()}`);
    }
    if (next === "public_app" && ["/policies", "/budgets", "/audit"].some((path) => pathname.startsWith(path))) {
      router.push("/");
    }
  };
  const logout = async () => {
    setLoggingOut(true);
    setLogoutError(null);
    try {
      await apiRequest("/auth/logout", { method: "POST" });
      router.replace("/login");
      router.refresh();
    } catch (caught) {
      setLogoutError(caught instanceof Error ? caught.message : "Unable to log out. Try again.");
    } finally {
      setLoggingOut(false);
    }
  };

  return (
    <AppShell
      onLogout={logout}
      logoutError={logoutError}
      loggingOut={loggingOut}
      onProfileChange={selectProfile}
      pendingChanges={pendingChanges}
      profile={profile}
      profiles={profiles.length ? profiles : ["public_app"]}
      user={{
        name: me.member.name ?? me.member.email,
        email: me.member.email,
        role: me.member.role,
      }}
      workspace={me.workspace}
      telemetrySearch={isTelemetryPath(pathname) ? { profile: searchParams.get("profile") === "enterprise_egress" ? "enterprise_egress" : "public_app", range: (["1h", "24h", "7d", "30d"].includes(searchParams.get("range") ?? "") ? searchParams.get("range")! : "24h") as "1h" | "24h" | "7d" | "30d" } : undefined}
    >
      {children}
    </AppShell>
  );
}
