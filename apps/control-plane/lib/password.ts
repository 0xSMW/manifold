import { hash, verify } from "@node-rs/argon2";

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

// OWASP's Argon2id baseline: 19 MiB, two iterations, one lane.  Keep these explicit so a
// package-default change cannot weaken stored human credentials.
export const PASSWORD_HASH_OPTIONS = {
  // @node-rs exposes Algorithm as an ambient const enum, which cannot be referenced with this
  // app's isolated-modules setting. Argon2id's stable library enum value is 2.
  algorithm: 2,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
} as const;

const DUMMY_PASSWORD = "manifold-dummy-password-v1";
const DUMMY_HASH = "$argon2id$v=19$m=19456,t=2,p=1$3GKyH1AUqhTBeXopzH/D7A$YL6m0/8ulpb15DpmyISAMVkd1dSkLr1Fp6f8m3xlIik";

export function isValidPassword(password: string): boolean {
  return password.length >= PASSWORD_MIN_LENGTH && password.length <= PASSWORD_MAX_LENGTH;
}

export function assertValidPassword(password: string): void {
  if (!isValidPassword(password)) {
    throw new Error(`Password must be between ${PASSWORD_MIN_LENGTH} and ${PASSWORD_MAX_LENGTH} characters`);
  }
}

export async function hashPassword(password: string): Promise<string> {
  assertValidPassword(password);
  return hash(password, PASSWORD_HASH_OPTIONS);
}

/**
 * Always performs Argon2 work when a stored hash is absent or malformed, preventing account
 * existence from becoming a timing oracle. Invalid submitted lengths are likewise rejected only
 * after dummy verification.
 */
export async function verifyPassword(password: string, storedHash: string | null | undefined): Promise<boolean> {
  const candidate = isValidPassword(password) ? password : DUMMY_PASSWORD;
  const target = storedHash && storedHash.startsWith("$argon2id$") ? storedHash : DUMMY_HASH;
  try {
    const matched = await verify(target, candidate, PASSWORD_HASH_OPTIONS);
    return Boolean(storedHash) && isValidPassword(password) && matched;
  } catch {
    await verify(DUMMY_HASH, DUMMY_PASSWORD, PASSWORD_HASH_OPTIONS);
    return false;
  }
}

export async function verifyDummyPassword(): Promise<void> {
  await verify(DUMMY_HASH, DUMMY_PASSWORD, PASSWORD_HASH_OPTIONS);
}
