// End-to-end control-plane driver. Real HTTP via global fetch, hard assertions, exits 1 on any fail.
const BASE = process.env.BASE;
const SEED = process.env.MANIFOLD_SEED_SECRET;
let failed = 0;
const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) failed++; };

async function j(res) { const t = await res.text(); try { return { s: res.status, b: JSON.parse(t) }; } catch { return { s: res.status, b: t }; } }

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

console.log(failed === 0 ? "\nALL-PASS" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
