"use client";

import { useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AuthCard, AuthNotice, safeNext } from "@/components/auth/auth-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import { apiRequest, ControlPlaneApiError } from "@/lib/api-client";

export default function LoginPage() {
  const router = useRouter(); const search = useSearchParams();
  const [email, setEmail] = useState(""); const [password, setPassword] = useState(""); const [error, setError] = useState<string | null>(null); const [working, setWorking] = useState(false);
  const submit = async (event: FormEvent) => { event.preventDefault(); setWorking(true); setError(null); try {
    await apiRequest("/auth/login", { method: "POST", body: { email, password } });
    setPassword(""); router.replace(safeNext(search.get("next"))); router.refresh();
  } catch (caught) { setError(caught instanceof ControlPlaneApiError ? caught.payload.message : "Unable to sign in. Try again."); } finally { setWorking(false); } };
  return <AuthCard description="Sign in to your workspace." title="Welcome back"><form className="console-form" onSubmit={submit}><label className="console-field"><span>Email</span><Input autoComplete="email" autoFocus onChange={(event) => setEmail(event.target.value)} required type="email" value={email} /></label><label className="console-field"><span>Password</span><Input autoComplete="current-password" onChange={(event) => setPassword(event.target.value)} required type="password" value={password} /></label>{error ? <AuthNotice>{error}</AuthNotice> : null}<Button disabled={working || !email || !password} type="submit" variant="primary">{working ? "Signing in" : "Sign in"}</Button></form><div className="auth-links"><a href="/forgot-password">Forgot password?</a><a href="/activate">Set up your workspace</a></div></AuthCard>;
}
