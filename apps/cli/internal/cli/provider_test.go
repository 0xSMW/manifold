package cli

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// These tests exercise the REAL control-plane HTTP path for the converted provider WRITE verbs
// (provider create → POST /providers, provider validate → POST /providers/<id>/validate) against a
// loopback httptest.Server. They reuse runCLI from health_test.go.

func TestProviderCreate_RealHTTP_PostsBodyWithAuth(t *testing.T) {
	var gotMethod, gotPath, gotAuth, gotContentType string
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		gotMethod = req.Method
		gotPath = req.URL.Path
		gotAuth = req.Header.Get("Authorization")
		gotContentType = req.Header.Get("Content-Type")
		raw, _ := io.ReadAll(req.Body)
		_ = json.Unmarshal(raw, &gotBody)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"id":"pc_1","provider":"openai","label":"prod","status":"unvalidated"}`))
	}))
	defer srv.Close()

	out, err := runCLI(t,
		"provider", "create",
		"--base-url", srv.URL,
		"--token", "tok-abc",
		"--provider", "openai",
		"--label", "prod",
		"--secret", "sk-xyz",
		"--provider-base-url", "https://api.example.com",
		"--allowed-hosts", "a.example.com, b.example.com",
		"--json",
	)
	if err != nil {
		t.Fatalf("provider create returned error: %v", err)
	}
	if gotMethod != http.MethodPost {
		t.Fatalf("wrong method: %q (want POST)", gotMethod)
	}
	if gotPath != "/api/v1/providers" {
		t.Fatalf("wrong path: %q (want /api/v1/providers)", gotPath)
	}
	if gotAuth != "Bearer tok-abc" {
		t.Fatalf("wrong auth header: %q (want Bearer tok-abc)", gotAuth)
	}
	if gotContentType != "application/json" {
		t.Fatalf("wrong content-type: %q (want application/json)", gotContentType)
	}
	if gotBody["provider"] != "openai" || gotBody["label"] != "prod" || gotBody["secret"] != "sk-xyz" {
		t.Fatalf("body missing required fields: %#v", gotBody)
	}
	if gotBody["baseUrl"] != "https://api.example.com" {
		t.Fatalf("body baseUrl mismatch: %#v", gotBody["baseUrl"])
	}
	hosts, ok := gotBody["allowedHosts"].([]any)
	if !ok || len(hosts) != 2 || hosts[0] != "a.example.com" || hosts[1] != "b.example.com" {
		t.Fatalf("body allowedHosts mismatch: %#v", gotBody["allowedHosts"])
	}
	var parsed map[string]any
	if e := json.Unmarshal([]byte(out), &parsed); e != nil {
		t.Fatalf("--json output is not the passed-through server body: %q (%v)", out, e)
	}
	if parsed["id"] != "pc_1" || parsed["status"] != "unvalidated" {
		t.Fatalf("passthrough body mismatch: %q", out)
	}
}

func TestProviderCreate_OmitsUnsetOptionalFields(t *testing.T) {
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		raw, _ := io.ReadAll(req.Body)
		_ = json.Unmarshal(raw, &gotBody)
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"id":"pc_2"}`))
	}))
	defer srv.Close()

	_, err := runCLI(t,
		"provider", "create",
		"--base-url", srv.URL,
		"--token", "tok",
		"--provider", "anthropic",
		"--label", "prod",
		"--secret", "sk-1",
		"--json",
	)
	if err != nil {
		t.Fatalf("provider create returned error: %v", err)
	}
	if _, present := gotBody["baseUrl"]; present {
		t.Fatalf("baseUrl should be omitted when unset: %#v", gotBody)
	}
	if _, present := gotBody["allowedHosts"]; present {
		t.Fatalf("allowedHosts should be omitted when unset: %#v", gotBody)
	}
}

func TestProviderCreate_MissingRequiredFlag_UsageError(t *testing.T) {
	// No --secret: buildLeaf's required-flag check should fail before any HTTP call.
	_, err := runCLI(t,
		"provider", "create",
		"--base-url", "http://127.0.0.1:1",
		"--provider", "openai",
		"--label", "prod",
	)
	if err == nil {
		t.Fatal("expected a usage error for missing --secret, got nil")
	}
	var cliErr *CLIError
	if !errors.As(err, &cliErr) {
		t.Fatalf("expected *CLIError, got %T: %v", err, err)
	}
	if cliErr.Code != ExitUsage {
		t.Fatalf("expected ExitUsage (2), got %d", cliErr.Code)
	}
}

func TestProviderValidate_RealHTTP_PostsToValidatePath(t *testing.T) {
	var gotMethod, gotPath, gotAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		gotMethod = req.Method
		gotPath = req.URL.Path
		gotAuth = req.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"id":"pc_9","status":"valid","validated":true}`))
	}))
	defer srv.Close()

	out, err := runCLI(t,
		"provider", "validate", "pc_9",
		"--base-url", srv.URL,
		"--token", "tok-v",
		"--json",
	)
	if err != nil {
		t.Fatalf("provider validate returned error: %v", err)
	}
	if gotMethod != http.MethodPost {
		t.Fatalf("wrong method: %q (want POST)", gotMethod)
	}
	if gotPath != "/api/v1/providers/pc_9/validate" {
		t.Fatalf("wrong path: %q (want /api/v1/providers/pc_9/validate)", gotPath)
	}
	if gotAuth != "Bearer tok-v" {
		t.Fatalf("wrong auth header: %q (want Bearer tok-v)", gotAuth)
	}
	var parsed map[string]any
	if e := json.Unmarshal([]byte(out), &parsed); e != nil {
		t.Fatalf("--json output is not the passed-through server body: %q (%v)", out, e)
	}
	if parsed["status"] != "valid" || parsed["validated"] != true {
		t.Fatalf("passthrough body mismatch: %q", out)
	}
}

func TestProviderValidate_NotFound_MapsToExitNotFound(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"error":{"code":"NOT_FOUND","message":"provider credential not found"}}`))
	}))
	defer srv.Close()

	_, err := runCLI(t,
		"provider", "validate", "pc_missing",
		"--base-url", srv.URL,
		"--token", "tok",
	)
	if err == nil {
		t.Fatal("expected a not-found error, got nil")
	}
	var cliErr *CLIError
	if !errors.As(err, &cliErr) {
		t.Fatalf("expected *CLIError, got %T: %v", err, err)
	}
	if cliErr.Code != ExitNotFound {
		t.Fatalf("expected ExitNotFound (4), got %d", cliErr.Code)
	}
	if cliErr.ErrCode != "NOT_FOUND" {
		t.Fatalf("expected ErrCode NOT_FOUND, got %q", cliErr.ErrCode)
	}
}

func TestProviderCreate_ValidationError_MapsToExitUsage(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"error":{"code":"VALIDATION","message":"bad provider"}}`))
	}))
	defer srv.Close()

	_, err := runCLI(t,
		"provider", "create",
		"--base-url", srv.URL,
		"--token", "tok",
		"--provider", "openai",
		"--label", "prod",
		"--secret", "sk-1",
	)
	if err == nil {
		t.Fatal("expected a validation error, got nil")
	}
	var cliErr *CLIError
	if !errors.As(err, &cliErr) {
		t.Fatalf("expected *CLIError, got %T: %v", err, err)
	}
	if cliErr.Code != ExitUsage {
		t.Fatalf("expected ExitUsage (2), got %d", cliErr.Code)
	}
}

func TestProviderRotateSecret_RealHTTP_PostsSecretAndMapsErrors(t *testing.T) {
	var method, path, auth, idempotencyKey string
	var body map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		method, path, auth, idempotencyKey = req.Method, req.URL.Path, req.Header.Get("Authorization"), req.Header.Get("Idempotency-Key")
		_ = json.NewDecoder(req.Body).Decode(&body)
		_, _ = w.Write([]byte(`{"id":"pc_1","status":"unvalidated","rotated":true,"plaintextStored":false}`))
	}))
	defer srv.Close()
	out, err := runCLI(t, "provider", "rotate", "pc_1", "--secret", "sk-new", "--base-url", srv.URL, "--token", "tok", "--json")
	if err != nil {
		t.Fatalf("rotate returned error: %v", err)
	}
	if method != http.MethodPost || path != "/api/v1/providers/pc_1/rotate" || auth != "Bearer tok" || idempotencyKey == "" || body["secret"] != "sk-new" {
		t.Fatalf("request = %s %s %q %#v", method, path, auth, body)
	}
	if !json.Valid([]byte(out)) {
		t.Fatalf("expected JSON output, got %q", out)
	}

	errSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"error":{"code":"NOT_FOUND","message":"missing"}}`))
	}))
	defer errSrv.Close()
	_, err = runCLI(t, "provider", "rotate", "missing", "--secret", "sk-new", "--base-url", errSrv.URL)
	var cliErr *CLIError
	if !errors.As(err, &cliErr) || cliErr.Code != ExitNotFound {
		t.Fatalf("expected not found error, got %v", err)
	}
}

func TestProviderRotateSecret_ValidatesSecretInput(t *testing.T) {
	_, err := runCLI(t, "provider", "rotate", "pc_1", "--base-url", "http://127.0.0.1:1")
	var cliErr *CLIError
	if !errors.As(err, &cliErr) || cliErr.Code != ExitUsage {
		t.Fatalf("expected usage error, got %v", err)
	}
}

func TestProviderRotateSecret_ReadsSecretFromBooleanStdinFlag(t *testing.T) {
	var body map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		_ = json.NewDecoder(req.Body).Decode(&body)
		_, _ = w.Write([]byte(`{"id":"pc_1","status":"unvalidated","rotated":true,"plaintextStored":false}`))
	}))
	defer srv.Close()

	secret := "stdin-only-provider-secret"
	buf := new(bytes.Buffer)
	r := newRootCmd()
	r.SetIn(bytes.NewBufferString(secret + "\n"))
	r.SetOut(buf)
	r.SetErr(buf)
	r.SetArgs([]string{"provider", "rotate", "pc_1", "--secret-stdin", "--base-url", srv.URL, "--json"})
	if err := r.Execute(); err != nil {
		t.Fatalf("stdin rotate returned error: %v", err)
	}
	if body["secret"] != secret {
		t.Fatalf("stdin secret body = %#v", body)
	}
	if strings.Contains(buf.String(), secret) {
		t.Fatalf("secret leaked into command output: %q", buf.String())
	}

	_, err := runCLI(t, "provider", "rotate", "pc_1", "--secret", "argv-secret", "--secret-stdin", "--base-url", srv.URL)
	var cliErr *CLIError
	if !errors.As(err, &cliErr) || cliErr.Code != ExitUsage {
		t.Fatalf("expected mutual-exclusion usage error, got %v", err)
	}
}

func TestProviderRevoke_RealHTTP_PostsEmptyAndMapsErrors(t *testing.T) {
	var method, path string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		method, path = req.Method, req.URL.Path
		_, _ = w.Write([]byte(`{"id":"pc_1","revoked":true}`))
	}))
	defer srv.Close()
	out, err := runCLI(t, "provider", "revoke", "pc_1", "--yes", "--base-url", srv.URL, "--json")
	if err != nil {
		t.Fatalf("revoke returned error: %v", err)
	}
	if method != http.MethodPost || path != "/api/v1/providers/pc_1/revoke" || !json.Valid([]byte(out)) {
		t.Fatalf("request/output mismatch: %s %s %q", method, path, out)
	}
	errSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"error":{"code":"FORBIDDEN","message":"denied"}}`))
	}))
	defer errSrv.Close()
	_, err = runCLI(t, "provider", "revoke", "pc_1", "--yes", "--base-url", errSrv.URL)
	var cliErr *CLIError
	if !errors.As(err, &cliErr) || cliErr.Code != ExitAuth {
		t.Fatalf("expected auth error, got %v", err)
	}
}
