// Shared seed helper for the gateway/config PG e2e suites (used with the throwaway-Postgres
// harness in pg-harness.ts). Every one of those suites needs the SAME minimal control-plane tenant
// so a config-built snapshot can authenticate a key and dispatch a chat request end-to-end:
//
//   workspace → canonical_model → data_encryption_key → provider_model_offering
//     → (optional) provider_price_revision  (offering.active_price_revision_id points at it)
//     → provider_credential → gateway_installation → gateway_ingress_profile
//     → gateway_route → gateway_route_revision → gateway_target  (route.active_revision_id)
//     → (optional) budget_account → virtual_key (bound to that budget account)
//
// The budget-e2e and observe-e2e suites copy-pasted this exact INSERT block, differing only in a
// per-suite id prefix, the ingress hostname, the key hash, the offering price, and the budget
// knobs. `seedMinimalGatewayTenant(opts)` returns that INSERT block as SQL text (for `pg.psql`),
// so a suite can append its own extra rows (e.g. a second budget account) verbatim after it.
//
// This module produces SQL strings ONLY — it imports nothing from the runtime packages, so it does
// not couple the database test dir to gateway/budget code.

/** Price for the tenant's single offering (per-million-token µ$). When set, the offering is pointed
 *  at this price revision (offering.active_price_revision_id), so a µ$/token budget can price. */
export interface SeedPriceOptions {
  /** Price revision id. Default `prc_${prefix}`. */
  id?: string;
  /** input_per_mtok_microusd. */
  inputPerMtokMicrousd: number | bigint;
  /** output_per_mtok_microusd. */
  outputPerMtokMicrousd: number | bigint;
  /** provider_price_revision.fidelity. Default `provider_verified`. */
  fidelity?: string;
  /** content_hash. Default `sha256:price${prefix}`. */
  contentHash?: string;
}

/** The tenant's single budget account, plus the virtual key gets bound to it. */
export interface SeedBudgetOptions {
  /** Budget account id. Default `ba_${prefix}`. */
  id?: string;
  /** budget_account.unit. Default `cost_microusd`. */
  unit?: string;
  /** budget_account."window". Default `total`. */
  window?: string;
  /** limit_amount (the cap). */
  limitAmount: number | bigint;
  /** enforcement. Default `hard`. */
  enforcement?: string;
  /** scope_type. Default `key`. */
  scopeType?: string;
  /** scope_id. Default the seeded key id (`vk_${prefix}`). */
  scopeId?: string;
  /** pricing_catalog_revision_id. A HARD budget requires one (schema CHECK hard_requires_pricing);
   *  default `pcr_${prefix}` when enforcement is `hard`, else null. Pass null to omit the column. */
  pricingCatalogRevisionId?: string | null;
}

export interface SeedGatewayTenantOptions {
  /** Per-suite id prefix. `be2e` yields ws_be2e, cm_be2e, off_be2e, … — every seeded id. */
  prefix: string;
  /** Ingress profile hostname (the request Host the gateway routes on). */
  hostname: string;
  /** hex(HMAC(pepper, key)) — the virtual key's keyed_hash, exactly what the gateway recomputes. */
  keyHashHex: string;
  /** workspace.name. Default `${prefix} Workspace`. Not load-bearing (never asserted). */
  workspaceName?: string;
  /** provider_credential.allowed_hosts JSON array text. Default `["api.openai.com"]` (the resolved
   *  base-url host, so the target survives the fail-closed egress filter). */
  allowedHosts?: string;
  /** gateway_ingress_profile.policy_revision_id. Default null (no policy bound). */
  policyRevisionId?: string | null;
  /** When set, seed a provider_price_revision and point the offering at it. */
  price?: SeedPriceOptions;
  /** When set, seed a budget_account and bind the virtual key to it. */
  budget?: SeedBudgetOptions;
}

/**
 * Build the SQL that seeds one minimal control-plane tenant. Returns a SQL string suitable for
 * `pg.psql(...)`; callers may concatenate additional INSERTs after it.
 */
export function seedMinimalGatewayTenant(opts: SeedGatewayTenantOptions): string {
  const {
    prefix,
    hostname,
    keyHashHex,
    workspaceName = `${prefix} Workspace`,
    allowedHosts = '["api.openai.com"]',
    policyRevisionId = null,
    price,
    budget,
  } = opts;

  // Every id is `<kind>_<prefix>` so a suite's asserted ids stay stable and readable.
  const ws = `ws_${prefix}`;
  const cm = `cm_${prefix}`;
  const dek = `dek_${prefix}`;
  const off = `off_${prefix}`;
  const cred = `cred_${prefix}`;
  const inst = `inst_${prefix}`;
  const prof = `prof_${prefix}`;
  const route = `route_${prefix}`;
  const rev = `rev_${prefix}`;
  const target = `tg_${prefix}`;
  const key = `vk_${prefix}`;
  const model = `${prefix}-model`;

  const statements: string[] = [
    `INSERT INTO workspace (id, slug, name, region) VALUES
      ('${ws}','ws-${prefix}','${workspaceName}','local');`,

    `INSERT INTO canonical_model (id, canonical_slug, display_name, catalog_revision) VALUES
      ('${cm}','${model}','${prefix.toUpperCase()} Model','cat1');`,

    `INSERT INTO data_encryption_key (id, workspace_id, wrapped_dek, kek_id, status) VALUES
      ('${dek}','${ws}','\\xdeadbeef','kek1','active');`,

    `INSERT INTO provider_model_offering
      (id, canonical_model_id, provider, provider_model_id, endpoint_kinds, adapter_revision,
       capabilities, catalog_revision) VALUES
      ('${off}','${cm}','openai','${model}','["chat"]','ar1','{}','cat1');`,
  ];

  if (price) {
    const priceId = price.id ?? `prc_${prefix}`;
    const fidelity = price.fidelity ?? "provider_verified";
    const contentHash = price.contentHash ?? `sha256:price${prefix}`;
    statements.push(
      `INSERT INTO provider_price_revision
        (id, offering_id, workspace_id, input_per_mtok_microusd, output_per_mtok_microusd,
         fidelity, content_hash, catalog_revision) VALUES
        ('${priceId}','${off}','${ws}',${String(price.inputPerMtokMicrousd)},${String(price.outputPerMtokMicrousd)},
         '${fidelity}','${contentHash}','cat1');`,
      `UPDATE provider_model_offering SET active_price_revision_id = '${priceId}' WHERE id = '${off}';`,
    );
  }

  statements.push(
    `INSERT INTO provider_credential
      (id, workspace_id, provider, label, encrypted_secret, dek_id, base_url, allowed_hosts, status) VALUES
      ('${cred}','${ws}','openai','openai key','\\xc0ffee','${dek}',NULL,'${allowedHosts}','valid');`,

    `INSERT INTO gateway_installation (id, workspace_id, name, workload_identity) VALUES
      ('${inst}','${ws}','inst-${prefix}','{"kind":"test"}');`,

    `INSERT INTO gateway_ingress_profile
      (id, workspace_id, installation_id, hostname, mode, auth_config${policyRevisionId ? ", policy_revision_id" : ""}) VALUES
      ('${prof}','${ws}','${inst}','${hostname}','public_app','{}'${policyRevisionId ? `,'${policyRevisionId}'` : ""});`,

    `INSERT INTO gateway_route (id, workspace_id, installation_id, public_name, endpoint_kind) VALUES
      ('${route}','${ws}','${inst}','chat-route','chat');`,

    `INSERT INTO gateway_route_revision
      (id, workspace_id, route_id, mode, retry_policy, timeout_policy, content_hash) VALUES
      ('${rev}','${ws}','${route}','ordered','{}','{"overall_ms":30000}','sha256:rev${prefix}');`,

    `INSERT INTO gateway_target
      (id, workspace_id, route_revision_id, provider_credential_id, offering_id, adapter_revision, base_url) VALUES
      ('${target}','${ws}','${rev}','${cred}','${off}','ar1',NULL);`,

    `UPDATE gateway_route SET active_revision_id = '${rev}' WHERE id = '${route}';`,
  );

  if (budget) {
    const baId = budget.id ?? `ba_${prefix}`;
    const unit = budget.unit ?? "cost_microusd";
    const window = budget.window ?? "total";
    const enforcement = budget.enforcement ?? "hard";
    const scopeType = budget.scopeType ?? "key";
    const scopeId = budget.scopeId ?? key;
    const pcr =
      budget.pricingCatalogRevisionId === undefined
        ? enforcement === "hard"
          ? `pcr_${prefix}`
          : null
        : budget.pricingCatalogRevisionId;

    statements.push(
      pcr === null
        ? `INSERT INTO budget_account
            (id, workspace_id, scope_type, scope_id, unit, "window", limit_amount, enforcement) VALUES
            ('${baId}','${ws}','${scopeType}','${scopeId}','${unit}','${window}',${String(budget.limitAmount)},'${enforcement}');`
        : `INSERT INTO budget_account
            (id, workspace_id, scope_type, scope_id, unit, "window", limit_amount, enforcement,
             pricing_catalog_revision_id) VALUES
            ('${baId}','${ws}','${scopeType}','${scopeId}','${unit}','${window}',${String(budget.limitAmount)},'${enforcement}','${pcr}');`,
      `INSERT INTO virtual_key
        (id, workspace_id, profile_id, display_prefix, keyed_hash, scopes, allowed_app_ids, budget_account_id) VALUES
        ('${key}','${ws}','${prof}','sk-${prefix}','\\x${keyHashHex}','[]','[]','${baId}');`,
    );
  } else {
    statements.push(
      `INSERT INTO virtual_key
        (id, workspace_id, profile_id, display_prefix, keyed_hash, scopes, allowed_app_ids) VALUES
        ('${key}','${ws}','${prof}','sk-${prefix}','\\x${keyHashHex}','[]','[]');`,
    );
  }

  return statements.join("\n\n");
}
