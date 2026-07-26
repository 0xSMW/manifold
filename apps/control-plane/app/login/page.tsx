"use client";

import { useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/field";
import { apiRequest, ControlPlaneApiError } from "@/lib/api-client";

export default function LoginPage() {
  const router = useRouter();
  const search = useSearchParams();
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await apiRequest("/session/login", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      setToken("");
      const next = search.get("next");
      router.replace(next?.startsWith("/") ? next : "/");
      router.refresh();
    } catch (caught) {
      const message =
        caught instanceof ControlPlaneApiError
          ? caught.payload.remediation ?? caught.message
          : "Unable to start browser session";
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="console-login">
      <Card className="console-login-card">
        <div>
          <h1>Sign in to Manifold</h1>
          <p>Exchange an active member API token for a secure browser session</p>
        </div>
        <form className="console-form" onSubmit={submit}>
          <label className="console-field">
            <span>API token</span>
            <Input
              autoComplete="off"
              autoFocus
              onChange={(event) => setToken(event.target.value)}
              placeholder="Paste token"
              required
              type="password"
              value={token}
            />
          </label>
          {error ? <p className="console-form-error" role="alert">{error}</p> : null}
          <Button disabled={loading || !token} type="submit" variant="primary">
            {loading ? "Starting session" : "Start session"}
          </Button>
        </form>
      </Card>
    </main>
  );
}
