package cli

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// These exercise the REAL client path (httptest is a real loopback HTTP server)
// for the converted `config` WRITE verbs. runCLI comes from health_test.go.

func TestConfigPlan_RealHTTP(t *testing.T) {
	var gotMethod, gotPath, gotAuth, gotCT string
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		gotMethod = req.Method
		gotPath = req.URL.Path
		gotAuth = req.Header.Get("Authorization")
		gotCT = req.Header.Get("Content-Type")
		raw, _ := io.ReadAll(req.Body)
		_ = json.Unmarshal(raw, &gotBody)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"installationId":"inst-1","planHash":"sha256:abc","noop":false}`))
	}))
	defer srv.Close()

	// --json → the raw control-plane body is passed through verbatim.
	out, err := runCLI(t, "config", "plan", "--installation", "inst-1",
		"--base-url", srv.URL, "--token", "tok-plan", "--json")
	if err != nil {
		t.Fatalf("config plan returned error: %v", err)
	}
	if gotMethod != http.MethodPost {
		t.Fatalf("method = %q, want POST", gotMethod)
	}
	if gotPath != "/api/v1/config/plan" {
		t.Fatalf("path = %q, want /api/v1/config/plan", gotPath)
	}
	if gotAuth != "Bearer tok-plan" {
		t.Fatalf("auth = %q, want Bearer tok-plan", gotAuth)
	}
	if gotCT != "application/json" {
		t.Fatalf("content-type = %q, want application/json", gotCT)
	}
	if gotBody["installationId"] != "inst-1" {
		t.Fatalf("request body installationId = %v, want inst-1 (body=%v)", gotBody["installationId"], gotBody)
	}
	var parsed map[string]any
	if e := json.Unmarshal([]byte(out), &parsed); e != nil {
		t.Fatalf("--json output is not the passthrough server body: %q (%v)", out, e)
	}
	if parsed["planHash"] != "sha256:abc" {
		t.Fatalf("passthrough planHash mismatch: %q", out)
	}
}

func TestConfigPlan_HumanPrintsPlanHash(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"planHash":"sha256:deadbeef","noop":false}`))
	}))
	defer srv.Close()

	out, err := runCLI(t, "config", "plan", "--installation", "inst-1", "--base-url", srv.URL)
	if err != nil {
		t.Fatalf("config plan returned error: %v", err)
	}
	if strings.TrimSpace(out) != "sha256:deadbeef" {
		t.Fatalf("human mode should print just the plan_hash, got %q", out)
	}
}

func TestConfigApply_RealHTTP(t *testing.T) {
	var gotMethod, gotPath, gotAuth string
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		gotMethod = req.Method
		gotPath = req.URL.Path
		gotAuth = req.Header.Get("Authorization")
		raw, _ := io.ReadAll(req.Body)
		_ = json.Unmarshal(raw, &gotBody)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"revisionId":"rev-9","outcome":"applied","noop":false}`))
	}))
	defer srv.Close()

	out, err := runCLI(t, "config", "apply",
		"--installation", "inst-1", "--plan-hash", "sha256:abc",
		"--approvals", "route:foo, price:bar",
		"--base-url", srv.URL, "--token", "tok-apply", "--json")
	if err != nil {
		t.Fatalf("config apply returned error: %v", err)
	}
	if gotMethod != http.MethodPost {
		t.Fatalf("method = %q, want POST", gotMethod)
	}
	if gotPath != "/api/v1/config/apply" {
		t.Fatalf("path = %q, want /api/v1/config/apply", gotPath)
	}
	if gotAuth != "Bearer tok-apply" {
		t.Fatalf("auth = %q, want Bearer tok-apply", gotAuth)
	}
	if gotBody["installationId"] != "inst-1" || gotBody["planHash"] != "sha256:abc" {
		t.Fatalf("request body mismatch: %v", gotBody)
	}
	approvals, ok := gotBody["approvals"].([]any)
	if !ok || len(approvals) != 2 || approvals[0] != "route:foo" || approvals[1] != "price:bar" {
		t.Fatalf("approvals not split/trimmed into a JSON array: %v", gotBody["approvals"])
	}
	var parsed map[string]any
	if e := json.Unmarshal([]byte(out), &parsed); e != nil || parsed["revisionId"] != "rev-9" {
		t.Fatalf("response not rendered: %q (%v)", out, e)
	}
}

func TestConfigApply_StalePlanHash_Exit5(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusConflict) // 409
		_, _ = w.Write([]byte(`{"error":{"code":"CONFIG_PRECONDITION_FAILED","message":"active revision advanced since plan","retryable":true}}`))
	}))
	defer srv.Close()

	_, err := runCLI(t, "config", "apply",
		"--installation", "inst-1", "--plan-hash", "stale",
		"--base-url", srv.URL, "--token", "tok")
	if err == nil {
		t.Fatal("expected a precondition error for HTTP 409, got nil")
	}
	var cliErr *CLIError
	if !errors.As(err, &cliErr) {
		t.Fatalf("expected *CLIError, got %T: %v", err, err)
	}
	if cliErr.ErrCode != "CONFIG_PRECONDITION_FAILED" {
		t.Fatalf("ErrCode = %q, want CONFIG_PRECONDITION_FAILED", cliErr.ErrCode)
	}
	if cliErr.Code != ExitPrecondition {
		t.Fatalf("exit code = %d, want %d (ExitPrecondition)", cliErr.Code, ExitPrecondition)
	}
}

func TestConfigActive_RealHTTP(t *testing.T) {
	var gotMethod, gotPath, gotAuth, gotInstall string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		gotMethod = req.Method
		gotPath = req.URL.Path
		gotAuth = req.Header.Get("Authorization")
		gotInstall = req.URL.Query().Get("installationId")
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"revisionId":"rev-1","contentHash":"sha256:xyz"}`))
	}))
	defer srv.Close()

	out, err := runCLI(t, "config", "active", "--installation", "inst-42",
		"--base-url", srv.URL, "--token", "tok-active", "--json")
	if err != nil {
		t.Fatalf("config active returned error: %v", err)
	}
	if gotMethod != http.MethodGet {
		t.Fatalf("method = %q, want GET", gotMethod)
	}
	if gotPath != "/api/v1/config/active" {
		t.Fatalf("path = %q, want /api/v1/config/active", gotPath)
	}
	if gotInstall != "inst-42" {
		t.Fatalf("installationId query = %q, want inst-42", gotInstall)
	}
	if gotAuth != "Bearer tok-active" {
		t.Fatalf("auth = %q, want Bearer tok-active", gotAuth)
	}
	var parsed map[string]any
	if e := json.Unmarshal([]byte(out), &parsed); e != nil || parsed["revisionId"] != "rev-1" {
		t.Fatalf("response not rendered: %q (%v)", out, e)
	}
}

func TestConfigApply_MissingRequiredFlags_Exit2(t *testing.T) {
	// No --plan-hash: buildLeaf's required-flag check fires before any HTTP call.
	_, err := runCLI(t, "config", "apply", "--installation", "inst-1", "--base-url", "http://127.0.0.1:1")
	if err == nil {
		t.Fatal("expected a usage error for the missing --plan-hash flag, got nil")
	}
	var cliErr *CLIError
	if !errors.As(err, &cliErr) || cliErr.Code != ExitUsage {
		t.Fatalf("expected usage error exit %d, got %v", ExitUsage, err)
	}
}
