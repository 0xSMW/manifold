package cli

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// These exercise the REAL client path for the converted key WRITE verbs (mint, revoke) against an
// httptest loopback server — real sockets, real HTTP, the same code that talks to the control plane.
// runCLI is the shared helper defined in health_test.go (not redefined here).

func TestKeyMint_RealHTTP_PostsBodyAndRendersPlaintext(t *testing.T) {
	var gotMethod, gotPath, gotAuth, gotCT string
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		gotMethod = req.Method
		gotPath = req.URL.Path
		gotAuth = req.Header.Get("Authorization")
		gotCT = req.Header.Get("Content-Type")
		_ = json.NewDecoder(req.Body).Decode(&gotBody)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"keyId":"key_123","displayPrefix":"sk-mf-abcd","plaintext":"sk-mf-abcdef0123456789"}`))
	}))
	defer srv.Close()

	out, err := runCLI(t, "key", "mint",
		"--base-url", srv.URL,
		"--token", "tok_secret",
		"--profile", "prof_1",
		"--scope", "chat",
		"--app", "app_9",
		"--json",
	)
	if err != nil {
		t.Fatalf("key mint returned error: %v", err)
	}
	if gotMethod != http.MethodPost {
		t.Fatalf("wrong method: %q (want POST)", gotMethod)
	}
	if gotPath != "/api/v1/keys" {
		t.Fatalf("wrong path: %q (want /api/v1/keys)", gotPath)
	}
	if gotAuth != "Bearer tok_secret" {
		t.Fatalf("wrong Authorization header: %q (want Bearer tok_secret)", gotAuth)
	}
	if gotCT != "application/json" {
		t.Fatalf("wrong Content-Type: %q (want application/json)", gotCT)
	}
	if gotBody["profileId"] != "prof_1" {
		t.Fatalf("body profileId = %v, want prof_1 (full body: %v)", gotBody["profileId"], gotBody)
	}
	if scopes, ok := gotBody["scopes"].([]any); !ok || len(scopes) != 1 || scopes[0] != "chat" {
		t.Fatalf("body scopes = %v, want [chat]", gotBody["scopes"])
	}
	if apps, ok := gotBody["allowedAppIds"].([]any); !ok || len(apps) != 1 || apps[0] != "app_9" {
		t.Fatalf("body allowedAppIds = %v, want [app_9]", gotBody["allowedAppIds"])
	}
	var parsed map[string]any
	if e := json.Unmarshal([]byte(out), &parsed); e != nil {
		t.Fatalf("--json output is not the passed-through body: %q (%v)", out, e)
	}
	if parsed["plaintext"] != "sk-mf-abcdef0123456789" {
		t.Fatalf("rendered body missing plaintext: %q", out)
	}
}

func TestKeyMint_RealHTTP_QuietPrintsPlaintextOnly(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"keyId":"key_123","displayPrefix":"sk-mf-abcd","plaintext":"sk-mf-plaintextonce"}`))
	}))
	defer srv.Close()

	out, err := runCLI(t, "key", "mint",
		"--base-url", srv.URL,
		"--profile", "prof_1",
		"--quiet",
	)
	if err != nil {
		t.Fatalf("key mint --quiet returned error: %v", err)
	}
	if strings.TrimSpace(out) != "sk-mf-plaintextonce" {
		t.Fatalf("--quiet output = %q, want just the plaintext", out)
	}
}

func TestKeyMint_RealHTTP_404MapsToNotFound(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"error":{"code":"NOT_FOUND","message":"ingress profile not found"}}`))
	}))
	defer srv.Close()

	_, err := runCLI(t, "key", "mint", "--base-url", srv.URL, "--profile", "prof_missing")
	if err == nil {
		t.Fatal("expected an error for HTTP 404, got nil")
	}
	var cliErr *CLIError
	if !errors.As(err, &cliErr) {
		t.Fatalf("expected *CLIError, got %T: %v", err, err)
	}
	if cliErr.Code != ExitNotFound {
		t.Fatalf("exit code = %d, want ExitNotFound (%d)", cliErr.Code, ExitNotFound)
	}
	if cliErr.ErrCode != "NOT_FOUND" {
		t.Fatalf("ErrCode = %q, want NOT_FOUND", cliErr.ErrCode)
	}
}

func TestKeyMint_MissingRequiredProfile(t *testing.T) {
	// --profile is Required; omitting it must fail before any HTTP call (usage error, exit 2).
	_, err := runCLI(t, "key", "mint", "--base-url", "http://127.0.0.1:1")
	if err == nil {
		t.Fatal("expected a usage error for missing --profile, got nil")
	}
	var cliErr *CLIError
	if !errors.As(err, &cliErr) {
		t.Fatalf("expected *CLIError, got %T", err)
	}
	if cliErr.Code != ExitUsage {
		t.Fatalf("exit code = %d, want ExitUsage (%d)", cliErr.Code, ExitUsage)
	}
}

func TestKeyRevoke_RealHTTP_PostsToRevokePath(t *testing.T) {
	var gotMethod, gotPath, gotAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		gotMethod = req.Method
		gotPath = req.URL.Path
		gotAuth = req.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"id":"key_abc","revoked":true}`))
	}))
	defer srv.Close()

	out, err := runCLI(t, "key", "revoke", "key_abc",
		"--base-url", srv.URL,
		"--token", "tok_secret",
		"--json",
	)
	if err != nil {
		t.Fatalf("key revoke returned error: %v", err)
	}
	if gotMethod != http.MethodPost {
		t.Fatalf("wrong method: %q (want POST)", gotMethod)
	}
	if gotPath != "/api/v1/keys/key_abc/revoke" {
		t.Fatalf("wrong path: %q (want /api/v1/keys/key_abc/revoke)", gotPath)
	}
	if gotAuth != "Bearer tok_secret" {
		t.Fatalf("wrong Authorization header: %q", gotAuth)
	}
	var parsed map[string]any
	if e := json.Unmarshal([]byte(out), &parsed); e != nil {
		t.Fatalf("--json output is not the passed-through body: %q (%v)", out, e)
	}
	if parsed["revoked"] != true || parsed["id"] != "key_abc" {
		t.Fatalf("rendered body mismatch: %q", out)
	}
}

func TestKeyRevoke_RealHTTP_404MapsToNotFound(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"error":{"code":"NOT_FOUND","message":"active virtual key not found"}}`))
	}))
	defer srv.Close()

	_, err := runCLI(t, "key", "revoke", "key_missing", "--base-url", srv.URL)
	if err == nil {
		t.Fatal("expected an error for HTTP 404, got nil")
	}
	var cliErr *CLIError
	if !errors.As(err, &cliErr) {
		t.Fatalf("expected *CLIError, got %T: %v", err, err)
	}
	if cliErr.Code != ExitNotFound {
		t.Fatalf("exit code = %d, want ExitNotFound (%d)", cliErr.Code, ExitNotFound)
	}
}
