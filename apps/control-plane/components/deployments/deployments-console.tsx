"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { AlertBanner } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, Skeleton } from "@/components/ui/card";
import { Input, Select } from "@/components/ui/field";
import { Sheet } from "@/components/ui/overlay";
import { StatusBadge } from "@/components/ui/status";
import { useToast } from "@/components/ui/toast";
import { EmptyState, PageFrame } from "@/components/console/page-frame";
import { apiRequest, ControlPlaneApiError, type PageResult } from "@/lib/api-client";
import type {
  IngressProfile,
  InstallationCreated,
  InstallationEdition,
  InstallationSummary,
  ProfileCreated,
  ProfileMode,
} from "./deployment-types";
import {
  emptyProfileDraft,
  ProfileFields,
  profileDraftComplete,
  profileRequest,
  type ProfileDraft,
} from "./profile-fields";
import styles from "./deployments.module.css";

function message(error: unknown): string {
  if (error instanceof ControlPlaneApiError) return error.payload.message;
  return error instanceof Error ? error.message : "Unable to load deployments";
}

function formatDate(value: string | null): string {
  if (!value) return "Not reported";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Unknown"
    : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function editionLabel(edition: InstallationEdition): string {
  if (edition === "cloudflare") return "Cloudflare";
  if (edition === "compose") return "Compose";
  return "Vercel";
}

export function DeploymentsConsole() {
  const toast = useToast();
  const [installations, setInstallations] = useState<InstallationSummary[] | null>(null);
  const [profiles, setProfiles] = useState<IngressProfile[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<"all" | ProfileMode>("all");
  const [wizardOpen, setWizardOpen] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [deploymentResult, profileResult] = await Promise.all([
        apiRequest<PageResult<InstallationSummary>>("/deployments"),
        apiRequest<PageResult<IngressProfile>>("/profiles"),
      ]);
      setInstallations(deploymentResult.data);
      setProfiles(profileResult.data);
    } catch (caught) {
      setInstallations([]);
      setError(message(caught));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const visible = useMemo(() => (installations ?? []).filter((installation) => {
    const matchesText = installation.name.toLowerCase().includes(query.trim().toLowerCase());
    const matchesMode = mode === "all" || profiles.some(
      (profile) => profile.installationId === installation.id && profile.mode === mode,
    );
    return matchesText && matchesMode;
  }), [installations, mode, profiles, query]);

  return (
    <PageFrame
      actions={<Button onClick={() => setWizardOpen(true)} variant="primary">Register gateway</Button>}
      description="Configure gateway installations, trusted host bindings, and serving readiness"
      title="Deployments"
    >
      <div className={styles.stack}>
        <div className={styles.notice}>
          <strong>Trusted host boundary</strong>
          <p>A profile is fixed to its trusted hostname. Headers, query parameters, token claims, and request bodies cannot select or upgrade the profile.</p>
        </div>
        {error ? (
          <AlertBanner title="Deployments could not load" tone="down">
            {error} <Button onClick={() => void load()} variant="outline">Retry</Button>
          </AlertBanner>
        ) : null}
        <Card>
          <div className={styles.toolbar}>
            <Input
              aria-label="Search deployments"
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search gateway name"
              style={{ maxWidth: 300 }}
              value={query}
            />
            <Select
              aria-label="Filter by ingress mode"
              onChange={(event) => setMode(event.target.value as typeof mode)}
              style={{ maxWidth: 210 }}
              value={mode}
            >
              <option value="all">All ingress modes</option>
              <option value="public_app">Public app</option>
              <option value="enterprise_egress">Enterprise egress</option>
            </Select>
            <span className={styles.toolbarCount}>
              {visible.length} gateway{visible.length === 1 ? "" : "s"}
            </span>
          </div>
          {installations === null ? <DeploymentSkeleton /> : null}
          {installations !== null && !error && installations.length === 0 ? (
            <EmptyState
              action={<Button onClick={() => setWizardOpen(true)} variant="primary">Register gateway</Button>}
              description="Stand up a gateway, register its installation identity, and bind the first trusted hostname."
              title="No gateway connected"
            />
          ) : null}
          {installations !== null && installations.length > 0 && visible.length === 0 ? (
            <EmptyState
              description="Try another gateway name or ingress mode."
              title="No matching gateways"
            />
          ) : null}
          {visible.length > 0 ? (
            <div className="console-table-wrap" style={{ border: 0, borderRadius: 0 }}>
              <table className="console-table">
                <thead>
                  <tr>
                    <th>Gateway</th>
                    <th>Edition</th>
                    <th>Profiles</th>
                    <th>Last heartbeat</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((installation) => {
                    const installationProfiles = profiles.filter(
                      (profile) => profile.installationId === installation.id,
                    );
                    return (
                      <tr key={installation.id}>
                        <td>
                          <a className={styles.nameLink} href={`/deployments/${installation.id}`}>
                            {installation.name}
                          </a>
                          <div className={styles.subtle}>
                            Registered {formatDate(installation.createdAt)}
                          </div>
                        </td>
                        <td>{editionLabel(installation.edition)}</td>
                        <td>
                          {installationProfiles.length
                            ? installationProfiles.map((profile) =>
                                profile.mode === "public_app" ? "Public app" : "Enterprise egress",
                              ).join(", ")
                            : "No trusted hosts"}
                        </td>
                        <td>{formatDate(installation.lastSeenAt)}</td>
                        <td>
                          <StatusBadge status={installation.status === "active" ? "up" : "down"}>
                            {installation.status === "active" ? "Active" : "Disabled"}
                          </StatusBadge>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : null}
        </Card>
      </div>
      <RegisterGatewaySheet
        onClose={() => setWizardOpen(false)}
        onRegistered={(installation) => {
          setInstallations((current) => [installation, ...(current ?? [])]);
          toast("Gateway registered", "up");
        }}
        open={wizardOpen}
      />
    </PageFrame>
  );
}
function DeploymentSkeleton() {
  return (
    <div className="console-stack" style={{ padding: 12 }}>
      <Skeleton style={{ height: 48 }} />
      <Skeleton style={{ height: 48 }} />
      <Skeleton style={{ height: 48 }} />
    </div>
  );
}

function RegisterGatewaySheet({
  open,
  onClose,
  onRegistered,
}: {
  open: boolean;
  onClose: () => void;
  onRegistered: (installation: InstallationSummary) => void;
}) {
  const [name, setName] = useState("");
  const [edition, setEdition] = useState<InstallationEdition>("vercel");
  const [profile, setProfile] = useState<ProfileDraft>(emptyProfileDraft);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<InstallationCreated | null>(null);
  const [profileCreated, setProfileCreated] = useState<ProfileCreated | null>(null);

  useEffect(() => {
    if (open) return;
    setName("");
    setEdition("vercel");
    setProfile(emptyProfileDraft);
    setSubmitting(false);
    setError(null);
    setCreated(null);
    setProfileCreated(null);
  }, [open]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!name.trim() || !profileDraftComplete(profile)) return;
    setSubmitting(true);
    setError(null);
    let installation: InstallationCreated | null = null;
    try {
      installation = await apiRequest<InstallationCreated>("/installations", {
        method: "POST",
        body: { name: name.trim(), edition },
      });
      setCreated(installation);
      onRegistered({
        id: installation.id,
        name: installation.name,
        edition: installation.edition,
        appliedConfigRevision: null,
        lastSeenAt: null,
        status: "active",
        createdAt: installation.createdAt ?? new Date().toISOString(),
      });
      const bound = await apiRequest<ProfileCreated>(`/deployments/${installation.id}/profiles`, {
        method: "POST",
        body: profileRequest(profile),
      });
      setProfileCreated(bound);
    } catch (caught) {
      const prefix = installation
        ? "The gateway was registered, but its trusted host was not bound. "
        : "";
      setError(`${prefix}${message(caught)}`);
    } finally {
      setSubmitting(false);
    }
  };

  const finish = () => {
    if (created) window.location.assign(`/deployments/${created.id}`);
    else onClose();
  };

  const copyPrivateKey = async () => {
    if (!created?.installationIdentityPrivateKey) return;
    try {
      await navigator.clipboard.writeText(created.installationIdentityPrivateKey);
    } catch {
      setError("The private key could not be copied. Select it and copy it before leaving.");
    }
  };

  return (
    <Sheet onClose={created ? finish : onClose} open={open} title="Register gateway">
      {created ? (
        <div className="console-form">
          <AlertBanner title={profileCreated ? "Gateway registered" : "Gateway identity created"} tone={profileCreated ? "up" : "verifying"}>
            {profileCreated
              ? "The trusted host is saved as a draft. Open Publish to make the binding effective."
              : "Complete the trusted host binding before publishing this gateway."}
          </AlertBanner>
          {created.installationIdentityPrivateKey ? (
            <div className={styles.secretBox}>
              <strong>Save the installation private key now</strong>
              <p className="console-muted" style={{ fontSize: 12, margin: 0 }}>
                This key is shown once. Store it in the gateway secret manager before leaving this screen.
              </p>
              <div className={styles.secret}>{created.installationIdentityPrivateKey}</div>
              <div><Button onClick={() => void copyPrivateKey()}>Copy private key</Button></div>
            </div>
          ) : null}
          {error ? <p className="console-form-error" role="alert">{error}</p> : null}
          <div className={styles.actions}>
            <Button onClick={finish} variant="primary">Open gateway</Button>
          </div>
        </div>
      ) : (
        <form className="console-form" onSubmit={submit}>
          <div className={styles.wizardGrid}>
            <label className="console-field">
              <span>Gateway name</span>
              <Input
                onChange={(event) => setName(event.target.value)}
                placeholder="Production gateway"
                required
                value={name}
              />
            </label>
            <label className="console-field">
              <span>Edition</span>
              <Select
                onChange={(event) => setEdition(event.target.value as InstallationEdition)}
                value={edition}
              >
                <option value="vercel">Vercel</option>
                <option value="cloudflare">Cloudflare</option>
                <option value="compose">Compose</option>
              </Select>
            </label>
          </div>
          <div className={styles.notice}>
            <strong>First trusted host</strong>
            <p>The mode is fixed when this profile is created. Changing trust mode requires a new profile.</p>
          </div>
          <ProfileFields draft={profile} onChange={setProfile} />
          {error ? <p className="console-form-error" role="alert">{error}</p> : null}
          <div className={styles.actions}>
            <Button disabled={submitting} onClick={onClose}>Cancel</Button>
            <Button
              disabled={submitting || !name.trim() || !profileDraftComplete(profile)}
              type="submit"
              variant="primary"
            >
              {submitting ? "Registering gateway" : "Register and bind host"}
            </Button>
          </div>
        </form>
      )}
    </Sheet>
  );
}
