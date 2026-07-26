"use client";
import { useEffect, useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AuthCard, AuthNotice } from "@/components/auth/auth-card";
import { PasswordFields } from "@/components/auth/password-fields";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import { apiRequest } from "@/lib/api-client";

export default function ActivatePage() {
  const router = useRouter(), search = useSearchParams(); const token = search.get("token");
  const [email, setEmail] = useState(""), [name, setName] = useState(""), [password, setPassword] = useState(""), [confirmation, setConfirmation] = useState(""), [state, setState] = useState<"loading" | "request" | "complete" | "unavailable">("loading"), [notice, setNotice] = useState<string | null>(null), [working, setWorking] = useState(false);
  useEffect(() => { if (token) { setState("complete"); return; } void apiRequest<{ required: boolean; configured: boolean }>("/auth/activation/status").then((result) => setState(result.required && !result.configured ? "request" : "unavailable")).catch(() => setState("unavailable")); }, [token]);
  const request = async (event: FormEvent) => { event.preventDefault(); setWorking(true); setNotice(null); try { await apiRequest("/auth/activation/request", { method: "POST", body: { email } }); setNotice("If activation is available for this email, we sent a secure setup link."); } catch { setNotice("We could not request setup. Try again shortly."); } finally { setWorking(false); } };
  const complete = async (event: FormEvent) => { event.preventDefault(); if (password !== confirmation) return setNotice("Passwords do not match."); setWorking(true); setNotice(null); try { await apiRequest("/auth/activation/complete", { method: "POST", body: { token, name, password } }); router.replace("/"); router.refresh(); } catch (caught) { setNotice(caught instanceof Error ? caught.message : "This setup link is unavailable."); } finally { setWorking(false); } };
  if (state === "loading") return <AuthCard description="Checking workspace setup." title="Set up Manifold"><p aria-busy="true">Loading…</p></AuthCard>;
  if (state === "unavailable") return <AuthCard description="This workspace is already configured, or setup is not available." title="Set up Manifold"><a className="auth-action-link" href="/login">Go to sign in</a></AuthCard>;
  return <AuthCard description={state === "complete" ? "Choose your name and a password to finish setup." : "Enter the owner email to receive a secure setup link."} title="Set up Manifold"><form className="console-form" onSubmit={state === "complete" ? complete : request}>{state === "request" ? <label className="console-field"><span>Owner email</span><Input autoComplete="email" onChange={(event) => setEmail(event.target.value)} required type="email" value={email} /></label> : <><label className="console-field"><span>Your name</span><Input autoComplete="name" onChange={(event) => setName(event.target.value)} required value={name} /></label><PasswordFields confirmation={confirmation} onConfirmation={setConfirmation} onPassword={setPassword} password={password} /></>}{notice ? <AuthNotice tone={notice.startsWith("If ") ? "success" : "error"}>{notice}</AuthNotice> : null}<Button disabled={working} type="submit" variant="primary">{working ? "Please wait" : state === "complete" ? "Finish setup" : "Email setup link"}</Button></form></AuthCard>;
}
