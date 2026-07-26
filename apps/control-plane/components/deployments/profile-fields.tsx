"use client";

import { Input, Select } from "@/components/ui/field";
import type { NetworkExposure, ProfileMode } from "./deployment-types";
import styles from "./deployments.module.css";

export type EnterpriseAuthMethod = "oidc" | "saml" | "workload_identity";

export interface ProfileDraft {
  hostname: string;
  mode: ProfileMode;
  networkExposure: NetworkExposure;
  audience: string;
  tokenTtlSeconds: string;
  enterpriseMethod: EnterpriseAuthMethod;
  issuer: string;
  metadataUrl: string;
  allowedCidrs: string;
  trustAnchors: string;
}

export const emptyProfileDraft: ProfileDraft = {
  hostname: "",
  mode: "public_app",
  networkExposure: "public",
  audience: "",
  tokenTtlSeconds: "900",
  enterpriseMethod: "oidc",
  issuer: "",
  metadataUrl: "",
  allowedCidrs: "",
  trustAnchors: "",
};

export function profileRequest(draft: ProfileDraft) {
  const authConfig = draft.mode === "public_app"
    ? {
        audience: draft.audience.trim(),
        tokenTtlSeconds: Number(draft.tokenTtlSeconds),
      }
    : draft.enterpriseMethod === "saml"
      ? {
          method: "saml",
          metadataUrl: draft.metadataUrl.trim(),
          audience: draft.audience.trim(),
        }
      : {
          method: draft.enterpriseMethod,
          issuer: draft.issuer.trim(),
          audience: draft.audience.trim(),
        };
  const networkConfig = draft.networkExposure === "vpc"
    ? {
        allowedCidrs: draft.allowedCidrs.split(",").map((item) => item.trim()).filter(Boolean),
      }
    : draft.networkExposure === "mtls"
      ? {
          trustAnchors: draft.trustAnchors.split("\n").map((item) => item.trim()).filter(Boolean),
        }
      : undefined;
  return {
    hostname: draft.hostname.trim(),
    mode: draft.mode,
    networkExposure: draft.networkExposure,
    authConfig,
    networkConfig,
  };
}

export function profileDraftComplete(draft: ProfileDraft): boolean {
  if (!draft.hostname.trim() || !draft.audience.trim()) return false;
  if (draft.mode === "public_app" && !draft.tokenTtlSeconds) return false;
  if (
    draft.mode === "enterprise_egress" &&
    (draft.enterpriseMethod === "saml" ? !draft.metadataUrl.trim() : !draft.issuer.trim())
  ) return false;
  if (draft.networkExposure === "vpc" && !draft.allowedCidrs.trim()) return false;
  if (draft.networkExposure === "mtls" && !draft.trustAnchors.trim()) return false;
  return true;
}

export function ProfileFields({
  draft,
  onChange,
}: {
  draft: ProfileDraft;
  onChange: (draft: ProfileDraft) => void;
}) {
  const set = <K extends keyof ProfileDraft>(key: K, value: ProfileDraft[K]) => {
    onChange({ ...draft, [key]: value });
  };
  return (
    <div className={styles.wizardGrid}>
      <Field className={styles.wide} label="Trusted hostname">
        <Input
          autoCapitalize="none"
          autoCorrect="off"
          onChange={(event) => set("hostname", event.target.value)}
          placeholder="api.example.com"
          required
          value={draft.hostname}
        />
        <Hint>Enter a bare DNS hostname without a scheme, port, path, or wildcard.</Hint>
      </Field>
      <Field label="Ingress mode">
        <Select
          onChange={(event) => set("mode", event.target.value as ProfileMode)}
          value={draft.mode}
        >
          <option value="public_app">Public app</option>
          <option value="enterprise_egress">Enterprise egress</option>
        </Select>
      </Field>
      <Field label="Network exposure">
        <Select
          onChange={(event) => set("networkExposure", event.target.value as NetworkExposure)}
          value={draft.networkExposure}
        >
          <option value="public">Public network</option>
          <option value="vpc">Private VPC</option>
          <option value="mtls">Mutual TLS</option>
        </Select>
      </Field>
      {draft.mode === "enterprise_egress" ? (
        <Field label="Authentication">
          <Select
            onChange={(event) => set("enterpriseMethod", event.target.value as EnterpriseAuthMethod)}
            value={draft.enterpriseMethod}
          >
            <option value="oidc">OIDC</option>
            <option value="saml">SAML</option>
            <option value="workload_identity">Workload identity</option>
          </Select>
        </Field>
      ) : null}
      <Field label={draft.mode === "public_app" ? "Token audience" : "Audience"}>
        <Input
          onChange={(event) => set("audience", event.target.value)}
          placeholder={draft.mode === "public_app" ? "manifold-public" : "manifold-enterprise"}
          required
          value={draft.audience}
        />
      </Field>
      {draft.mode === "public_app" ? (
        <Field label="Token lifetime">
          <Select
            onChange={(event) => set("tokenTtlSeconds", event.target.value)}
            value={draft.tokenTtlSeconds}
          >
            <option value="300">5 minutes</option>
            <option value="900">15 minutes</option>
            <option value="1800">30 minutes</option>
            <option value="3600">1 hour</option>
          </Select>
        </Field>
      ) : draft.enterpriseMethod === "saml" ? (
        <Field className={styles.wide} label="SAML metadata URL">
          <Input
            onChange={(event) => set("metadataUrl", event.target.value)}
            placeholder="https://id.example.com/metadata"
            required
            type="url"
            value={draft.metadataUrl}
          />
        </Field>
      ) : (
        <Field className={styles.wide} label="Issuer URL">
          <Input
            onChange={(event) => set("issuer", event.target.value)}
            placeholder="https://id.example.com"
            required
            type="url"
            value={draft.issuer}
          />
        </Field>
      )}
      {draft.networkExposure === "vpc" ? (
        <Field className={styles.wide} label="Allowed CIDRs">
          <Input
            onChange={(event) => set("allowedCidrs", event.target.value)}
            placeholder="10.20.0.0/16, 2001:db8::/48"
            required
            value={draft.allowedCidrs}
          />
          <Hint>Separate multiple network ranges with commas.</Hint>
        </Field>
      ) : null}
      {draft.networkExposure === "mtls" ? (
        <Field className={styles.wide} label="Trust anchors">
          <textarea
            className="cp-input"
            onChange={(event) => set("trustAnchors", event.target.value)}
            placeholder="Enter one trust anchor per line"
            required
            rows={4}
            value={draft.trustAnchors}
          />
        </Field>
      ) : null}
    </div>
  );
}

function Field({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <label className={`${className ?? ""} console-field`}>
      <span>{label}</span>
      {children}
    </label>
  );
}

function Hint({ children }: { children: React.ReactNode }) {
  return <small className="console-muted">{children}</small>;
}
