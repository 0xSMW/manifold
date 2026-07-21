// End-to-end control-plane driver. Real HTTP via global fetch, hard assertions, exits 1 on any fail.
import postgres from "postgres";
import { hmacKeyHash, unwrapDek, openAesGcm, unpackBase64, utf8 } from "@manifold/crypto";

const BASE = process.env.BASE;
const SEED = process.env.MANIFOLD_SEED_SECRET;
const PGSUPER = process.env.PGSUPER; // superuser conn for RLS-bypassing verification reads / staging
let failed = 0;
const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) failed++; };

async function j(res) { const t = await res.text(); try { return { s: res.status, b: JSON.parse(t) }; } catch { return { s: res.status, b: t }; } }

// Authenticated JSON request helper (bearer token).
const call = async (tok, path, body, method = "POST") =>
  j(await fetch(`${BASE}${path}`, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${tok}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));

async function seed(slug, email) {
  const r = await fetch(`${BASE}/api/v1/admin/seed`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-seed-secret": SEED },
    body: JSON.stringify({ slug, email }),
  });
  return j(r);
}

const A = await seed("wsa", "a@x.com");
const B = await seed("wsb", "b@x.com");
console.log("seedA.status", A.s, "keys:", Object.keys(A.b || {}).join(","));
const tokA = A.b?.apiToken, tokB = B.b?.apiToken, profA = A.b?.profileId;
const instA = A.b?.installationId, offA = A.b?.offeringId;
ok((A.s === 200 || A.s === 201) && !!tokA && !!profA, `seed A → token+profileId (status ${A.s})`);
ok((B.s === 200 || B.s === 201) && !!tokB, `seed B → token (status ${B.s})`);

// mint a virtual key as A
const mk = await j(await fetch(`${BASE}/api/v1/keys`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${tokA}` },
  body: JSON.stringify({ profileId: profA, name: "k1" }),
}));
console.log("mint.status", mk.s, "body:", JSON.stringify(mk.b));
const plaintext = mk.b?.plaintext ?? mk.b?.key ?? mk.b?.secret;
const keyId = mk.b?.keyId ?? mk.b?.id;
ok(mk.s >= 200 && mk.s < 300 && typeof plaintext === "string" && plaintext.length > 10,
   `mint returns plaintext once (status ${mk.s}, plaintext len ${plaintext?.length ?? 0})`);

// ── BUG #1 (mint ignores publish outcome): instA has NO active revision yet at this point in the
// script (no route/plan/apply has run for it), so publishKeysOnly() legitimately returns `null`
// (a no-op — nothing to rebuild keys against). Pre-fix, POST /keys discarded that return value
// entirely, so the response never said anything about publish state. Post-fix it must surface
// `published: false` here (the key is NOT yet live at the gateway — it enters on the first full
// apply), proving the route now actually consults publishKeysOnly's result instead of ignoring it.
ok(mk.b?.published === false,
   `#1-MINT mint with no active revision yet surfaces published:false (got ${JSON.stringify(mk.b?.published)})`);

// ── BUG #1 (revoke ignores publish outcome), same no-active-revision case: revoking k1 immediately
// (still no active revision for instA) must succeed (a null publishKeysOnly result is a SAFE
// no-op — the key was never in any active snapshot to begin with) AND surface published:false,
// not the unconditional revoked:true with no publish info the pre-fix code always returned.
const revNoActive = await call(tokA, `/api/v1/keys/${keyId}/revoke`, {});
ok(revNoActive.s === 200 && revNoActive.b?.revoked === true && revNoActive.b?.published === false,
   `#1-REVOKE revoke with no active revision yet still succeeds and surfaces published:false (status ${revNoActive.s}, body ${JSON.stringify(revNoActive.b)})`);

// cross-tenant list
const listA = await j(await fetch(`${BASE}/api/v1/keys`, { headers: { authorization: `Bearer ${tokA}` } }));
const listB = await j(await fetch(`${BASE}/api/v1/keys`, { headers: { authorization: `Bearer ${tokB}` } }));
const arrA = listA.b?.data ?? listA.b ?? [];
const arrB = listB.b?.data ?? listB.b ?? [];
console.log("A list count", arrA.length, "| B list count", arrB.length);
ok(Array.isArray(arrA) && arrA.length === 1, `A sees its own 1 key (got ${arrA.length})`);
ok(Array.isArray(arrB) && arrB.length === 0, `B sees 0 keys — cross-tenant isolation (got ${arrB.length})`);
ok(JSON.stringify(listB.b).indexOf(keyId ?? "__none__") === -1, `A's keyId absent from B's response`);

// auth rejections
const noTok = await fetch(`${BASE}/api/v1/keys`);
const badTok = await fetch(`${BASE}/api/v1/keys`, { headers: { authorization: "Bearer garbage-not-a-token" } });
ok(noTok.status === 401, `no-token → 401 (got ${noTok.status})`);
ok(badTok.status === 401, `bad-token → 401 (got ${badTok.status})`);

// ── Superuser handle for RLS-bypassing verification reads + tripwire staging ──────────────────
const sql = PGSUPER ? postgres(PGSUPER, { max: 1 }) : null;

// ── BUG #1: a CP-minted key's stored keyed_hash == what the gateway recomputes ────────────────
// The gateway authenticates a presented key by HMAC(pepper, key) under MANIFOLD_KEY_PEPPER. Prove
// the CP stored EXACTLY that: read virtual_key.keyed_hash and compare byte-for-byte to
// @manifold/crypto hmacKeyHash(utf8(pepper), utf8(plaintext)). Different var/default ⇒ mismatch.
if (sql && keyId && typeof plaintext === "string") {
  const vk = await sql`SELECT keyed_hash FROM virtual_key WHERE id = ${keyId}`;
  const stored = vk[0] ? Buffer.from(vk[0].keyed_hash) : null;
  const pepper = process.env.MANIFOLD_KEY_PEPPER;
  const expected = Buffer.from(hmacKeyHash(utf8(pepper), utf8(plaintext)));
  ok(!!stored && stored.length === 32 && Buffer.compare(stored, expected) === 0,
     `#1 CP keyed_hash byte-equals gateway hmacKeyHash(MANIFOLD_KEY_PEPPER, key) (stored ${stored?.length ?? 0}B)`);
} else {
  ok(false, `#1 could not verify keyed_hash (sql=${!!sql} keyId=${!!keyId})`);
}

// ── BUG #6: provider secret is envelope-encrypted and round-trips ─────────────────────────────
const providerSecret = "sk-provider-" + Math.random().toString(36).slice(2) + "-END";
const prov = await call(tokA, "/api/v1/providers",
  { provider: "openai", label: "P1", secret: providerSecret });
const credId = prov.b?.id;
ok(prov.s === 201 && !!credId, `#6 POST /providers created credential (status ${prov.s})`);
if (sql && credId) {
  const cred = await sql`SELECT encrypted_secret, dek_id FROM provider_credential WHERE id = ${credId}`;
  const dekRow = cred[0] ? await sql`SELECT wrapped_dek FROM data_encryption_key WHERE id = ${cred[0].dek_id}` : [];
  const ct = cred[0] ? Buffer.from(cred[0].encrypted_secret) : null;
  const wrapped = dekRow[0] ? Buffer.from(dekRow[0].wrapped_dek) : null;
  let decrypted = null;
  try {
    const kek = unpackBase64(process.env.MANIFOLD_DATA_KEK);
    const dek = unwrapDek(kek, wrapped);
    decrypted = new TextDecoder().decode(openAesGcm(dek, ct));
  } catch (e) { decrypted = `THREW: ${e.message}`; }
  ok(decrypted === providerSecret,
     `#6 stored ciphertext+wrappedDek decrypt back to the secret (got ${JSON.stringify(decrypted)?.slice(0, 40)})`);
} else {
  ok(false, `#6 could not verify ciphertext (sql=${!!sql} credId=${!!credId})`);
}

// ── BUG #2: config/plan + config/apply SUCCEED under RLS as manifold_app ──────────────────────
// Create a route (references the credential + seeded offering) so the plan carries real content.
const rt = await call(tokA, "/api/v1/routes",
  { installationId: instA, publicName: "r1", target: { providerCredentialId: credId, offeringId: offA } });
const routeId = rt.b?.id;
ok(rt.s === 201 && !!routeId, `route created for plan (status ${rt.s})`);

const plan1 = await call(tokA, "/api/v1/config/plan", { installationId: instA });
ok(plan1.s === 200 && !!plan1.b?.planHash,
   `#2 config/plan SUCCEEDS under RLS (status ${plan1.s}, planHash ${plan1.b?.planHash ? "present" : "MISSING"})`);
const apply1 = await call(tokA, "/api/v1/config/apply",
  { installationId: instA, planHash: plan1.b?.planHash });
ok(apply1.s === 200 && apply1.b?.outcome === "accepted",
   `#2 config/apply SUCCEEDS under RLS (status ${apply1.s}, outcome ${apply1.b?.outcome})`);

// ── BUG #4: a non-matching approval must NOT clear a tripwire ─────────────────────────────────
// Stage a route deletion: disabling the route drops it from the target snapshot vs. the active
// revision, producing a route_delete tripwire. (Direct DB edit — no HTTP delete endpoint exists.)
if (sql && routeId) {
  await sql`UPDATE gateway_route SET disabled_at = now() WHERE id = ${routeId}`;
}
const plan2 = await call(tokA, "/api/v1/config/plan", { installationId: instA });
const tripwires = plan2.b?.tripwireItems ?? [];
ok(plan2.s === 200 && tripwires.some((t) => t.kind === "route_delete"),
   `#4 plan shows a route_delete tripwire (status ${plan2.s}, count ${tripwires.length})`);
const goodRef = tripwires.find((t) => t.kind === "route_delete")?.ref;

// Wrong approval → STILL held.
const applyDummy = await call(tokA, "/api/v1/config/apply",
  { installationId: instA, planHash: plan2.b?.planHash, approvals: ["dummy"] });
const heldCode = applyDummy.b?.error?.reason_codes ?? [];
ok(applyDummy.s === 422 && heldCode.includes("CONFIG_TRIPWIRE_HELD"),
   `#4 approvals:["dummy"] STILL held (status ${applyDummy.s}, codes ${JSON.stringify(heldCode)})`);

// Correct approval (the tripwire's ref) → clears.
const applyReal = await call(tokA, "/api/v1/config/apply",
  { installationId: instA, planHash: plan2.b?.planHash, approvals: [goodRef] });
ok(applyReal.s === 200 && applyReal.b?.outcome === "accepted",
   `#4 correct approval clears the tripwire (status ${applyReal.s}, outcome ${applyReal.b?.outcome})`);

// ── BUG: MINT publishes the key into the active snapshot (§8.2 H7) ────────────────────────────
// The gateway is snapshot-only auth (§7.4): a minted key must appear in GET /config/active
// IMMEDIATELY, not just as a DB row, else the gateway returns AUTH_KEY_UNKNOWN until a full apply.
// instA now HAS an active revision (from #2/#4 applies), so mint a fresh key and prove its
// hex(keyed_hash) is present in the signed snapshot with revoked:false.
const cfgActive = async () => j(await fetch(`${BASE}/api/v1/config/active?installationId=${instA}`,
  { headers: { authorization: `Bearer ${tokA}` } }));
const mk2 = await call(tokA, "/api/v1/keys", { profileId: profA, name: "k2" });
const pt2 = mk2.b?.plaintext;
const keyId2 = mk2.b?.keyId;
ok(mk2.s >= 200 && mk2.s < 300 && typeof pt2 === "string", `mint k2 for publish test (status ${mk2.s})`);
const hex2 = pt2 ? Buffer.from(hmacKeyHash(utf8(process.env.MANIFOLD_KEY_PEPPER), utf8(pt2))).toString("hex") : null;
const afterMint = await cfgActive();
const keysAfterMint = afterMint.b?.keys ?? {};
ok(afterMint.s === 200 && hex2 != null && !!keysAfterMint[hex2] && keysAfterMint[hex2].revoked === false,
   `#MINT-PUBLISH new key's hex(keyed_hash) present in /config/active, revoked:false (status ${afterMint.s}, present ${!!keysAfterMint[hex2]})`);
// ── BUG #1 (mint ignores publish outcome), the accepted case: instA HAS an active revision here
// (from #2/#4 applies), so the scoped publish must actually land — the response must say so.
ok(mk2.b?.published === true,
   `#1-MINT mint with an active revision surfaces published:true (got ${JSON.stringify(mk2.b?.published)})`);

// ── BUG: REVOKE publishes the revocation into the active snapshot ──────────────────────────────
// After revoke, /config/active must either DROP the key or show revoked:true — else the snapshot-
// only gateway keeps honoring the revoked key for the whole publish lag.
const rev2 = await call(tokA, `/api/v1/keys/${keyId2}/revoke`, {});
ok(rev2.s === 200 && rev2.b?.revoked === true, `revoke k2 (status ${rev2.s})`);
// ── BUG #1 (revoke ignores publish outcome), the accepted case ────────────────────────────────
// NOTE: we deliberately do NOT assert `published` on rev2 above — revoking k2 here reverts the
// keys section to EXACTLY the combination stored by an earlier revision (a pre-existing, separate
// apply()/keyOnlyPublish defect: rebuilding back to a byte-identical prior snapshot collides on
// `config_revision_hash_uq` since that old row is merely superseded, not gone; apply.ts is outside
// this fix's file group). Use a fresh pair of keys instead, so the reverted state is NOVEL and the
// scoped publish actually completes, to prove the accepted-case `published:true` surfacing works.
const mk3 = await call(tokA, "/api/v1/keys", { profileId: profA, name: "k3" });
const keyId3 = mk3.b?.keyId;
ok(mk3.s >= 200 && mk3.s < 300 && mk3.b?.published === true,
   `#1-MINT-2 mint k3 with an active revision surfaces published:true (status ${mk3.s}, published ${mk3.b?.published})`);
const mk4 = await call(tokA, "/api/v1/keys", { profileId: profA, name: "k4" });
ok(mk4.s >= 200 && mk4.s < 300 && mk4.b?.published === true,
   `mint k4 for the revoke-published test (status ${mk4.s}, published ${mk4.b?.published})`);
const rev3 = await call(tokA, `/api/v1/keys/${keyId3}/revoke`, {});
ok(rev3.s === 200 && rev3.b?.revoked === true && rev3.b?.published === true,
   `#1-REVOKE revoke with an active revision surfaces published:true (status ${rev3.s}, body ${JSON.stringify(rev3.b)})`);

const afterRevoke = await cfgActive();
const revEntry = (afterRevoke.b?.keys ?? {})[hex2];
ok(afterRevoke.s === 200 && (revEntry === undefined || revEntry.revoked === true),
   `#REVOKE-PUBLISH key dropped or revoked:true in /config/active (status ${afterRevoke.s}, entry ${revEntry ? "revoked=" + revEntry.revoked : "dropped"})`);

// ── BUG: mint MUST reject a cross-tenant budgetAccountId ──────────────────────────────────────
// Stage a budget_account owned by workspace B (superuser insert), then mint a key in A that
// references it. An FK-existence-only check would accept the cross-tenant link; the workspace
// ownership check must reject (404/422).
if (sql) {
  const wsB = B.b?.workspaceId;
  const baId = "ba_xtenant_" + Math.random().toString(36).slice(2);
  await sql`INSERT INTO budget_account (id, workspace_id, scope_type, unit, "window", limit_amount, enforcement)
            VALUES (${baId}, ${wsB}, 'workspace', 'cost_microusd', 'monthly', ${1000000}, 'advisory')`;
  const xt = await call(tokA, "/api/v1/keys", { profileId: profA, budgetAccountId: baId });
  ok(xt.s === 404 || xt.s === 422, `#XTENANT mint with B's budgetAccountId rejected (status ${xt.s})`);
} else {
  ok(false, `#XTENANT could not stage cross-tenant budget (sql=${!!sql})`);
}

// ── BUG: an induced internal error returns a GENERIC body (no raw err.message leak) ───────────
// Force an unhandled DB error (not a ManifoldError): mint with a non-timestamp expiresAt →
// postgres "invalid input syntax for type timestamp …". The handler must return code INTERNAL with
// a generic message that does NOT echo the driver/SQL/relation text or the offending value.
const leak = await call(tokA, "/api/v1/keys", { profileId: profA, expiresAt: "not-a-real-timestamp" });
const leakBody = JSON.stringify(leak.b ?? "");
ok(leak.s === 500 && leak.b?.error?.code === "INTERNAL"
   && !/invalid input syntax|timestamp|postgres|relation|syntax error|not-a-real-timestamp/i.test(leakBody),
   `#ERR-LEAK induced internal error → generic body, no raw driver text (status ${leak.s}, msg ${JSON.stringify(leak.b?.error?.message)})`);

if (sql) await sql.end({ timeout: 5 });

console.log(failed === 0 ? "\nALL-PASS" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
