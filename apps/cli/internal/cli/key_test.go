package cli

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strconv"
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

func TestKeyMint_InvalidCopyOnceResponseIncludesExplicitRecoveryKey(t *testing.T) {
	const recoveryKey = "mint-recovery-key"
	const responsePlaintext = "sk-mf-must-not-leak"
	for _, body := range []string{"", "not json", `{"plaintext":""}`, `{"plaintext":"` + responsePlaintext + `"} trailing`} {
		t.Run("response="+strconv.Quote(body), func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(http.StatusCreated)
				_, _ = w.Write([]byte(body))
			}))
			defer srv.Close()

			_, err := runCLI(t, "key", "mint", "--base-url", srv.URL, "--profile", "prof_1", "--idempotency-key", recoveryKey)
			assertCopyOnceRecoveryError(t, err, recoveryKey, responsePlaintext)
		})
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

	out, err := runCLI(t, "key", "revoke", "key_abc", "--yes",
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

	_, err := runCLI(t, "key", "revoke", "key_missing", "--yes", "--base-url", srv.URL)
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

func TestKeyRotate_RealHTTP_PostsGraceAndRendersPlaintext(t *testing.T) {
	var method, path, idempotencyKey string
	var body map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		method, path, idempotencyKey = req.Method, req.URL.Path, req.Header.Get("Idempotency-Key")
		_ = json.NewDecoder(req.Body).Decode(&body)
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"predecessorKeyId":"key_1","successorKeyId":"key_2","displayPrefix":"sk-mf-new","plaintext":"sk-mf-copy-once","graceExpiresAt":"2026-08-01T00:00:00Z","graceSemantics":"grace","published":false}`))
	}))
	defer srv.Close()
	out, err := runCLI(t, "key", "rotate", "key_1", "--grace-seconds", "120", "--base-url", srv.URL, "--json")
	if err != nil {
		t.Fatalf("rotate returned error: %v", err)
	}
	if method != http.MethodPost || path != "/api/v1/keys/key_1/rotate" || idempotencyKey == "" || body["graceSeconds"] != float64(120) {
		t.Fatalf("request = %s %s %#v", method, path, body)
	}
	if !json.Valid([]byte(out)) {
		t.Fatalf("expected JSON output, got %q", out)
	}
}

func TestKeyRotate_ValidatesGraceAndMapsErrors(t *testing.T) {
	_, err := runCLI(t, "key", "rotate", "key_1", "--grace-seconds", "59", "--base-url", "http://127.0.0.1:1")
	var cliErr *CLIError
	if !errors.As(err, &cliErr) || cliErr.Code != ExitUsage {
		t.Fatalf("expected usage error, got %v", err)
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"error":{"code":"NOT_FOUND","message":"missing"}}`))
	}))
	defer srv.Close()
	_, err = runCLI(t, "key", "rotate", "missing", "--base-url", srv.URL)
	if !errors.As(err, &cliErr) || cliErr.Code != ExitNotFound {
		t.Fatalf("expected not found error, got %v", err)
	}
}

func TestKeyRotate_InvalidCopyOnceResponseIncludesGeneratedRecoveryKey(t *testing.T) {
	var receivedKey string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		receivedKey = req.Header.Get("Idempotency-Key")
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"plaintext":""}`))
	}))
	defer srv.Close()

	_, err := runCLI(t, "key", "rotate", "key_1", "--base-url", srv.URL)
	if receivedKey == "" {
		t.Fatal("rotate request omitted generated Idempotency-Key")
	}
	assertCopyOnceRecoveryError(t, err, receivedKey, "")
}

func assertCopyOnceRecoveryError(t *testing.T, err error, wantKey, mustNotContain string) {
	t.Helper()
	var cliErr *CLIError
	if !errors.As(err, &cliErr) {
		t.Fatalf("expected *CLIError, got %T: %v", err, err)
	}
	if cliErr.ErrCode != "CLI_COPY_ONCE_RESPONSE_INVALID" {
		t.Fatalf("ErrCode = %q", cliErr.ErrCode)
	}
	if cliErr.Details["idempotency_key"] != wantKey {
		t.Fatalf("details = %#v, want recovery key %q", cliErr.Details, wantKey)
	}

	previousJSON := flagJSON
	defer func() { flagJSON = previousJSON }()
	for _, jsonOutput := range []bool{false, true} {
		flagJSON = jsonOutput
		var output bytes.Buffer
		writeError(&output, cliErr)
		if !strings.Contains(output.String(), wantKey) {
			t.Fatalf("json=%t output omitted recovery key: %q", jsonOutput, output.String())
		}
		if mustNotContain != "" && strings.Contains(output.String(), mustNotContain) {
			t.Fatalf("json=%t output leaked response plaintext: %q", jsonOutput, output.String())
		}
		if jsonOutput {
			var parsed errorEnvelope
			if err := json.Unmarshal(output.Bytes(), &parsed); err != nil {
				t.Fatalf("error output is not JSON: %v", err)
			}
			if parsed.Error.Details["idempotency_key"] != wantKey {
				t.Fatalf("JSON details = %#v", parsed.Error.Details)
			}
		}
	}
}

func TestKeyUpdateScopes_RealHTTP_PatchesScopesAndValidatesInput(t *testing.T) {
	var method, path string
	var body map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		method, path = req.Method, req.URL.Path
		_ = json.NewDecoder(req.Body).Decode(&body)
		_, _ = w.Write([]byte(`{"id":"key_1","scopes":["chat","embed"],"published":true}`))
	}))
	defer srv.Close()
	out, err := runCLI(t, "key", "update-scopes", "key_1", "--scopes", "chat, embed", "--base-url", srv.URL, "--json")
	if err != nil {
		t.Fatalf("update scopes returned error: %v", err)
	}
	scopes, ok := body["scopes"].([]any)
	if method != http.MethodPatch || path != "/api/v1/keys/key_1" || !ok || len(scopes) != 2 || scopes[1] != "embed" || !json.Valid([]byte(out)) {
		t.Fatalf("request/output mismatch: %s %s %#v %q", method, path, body, out)
	}
	_, err = runCLI(t, "key", "update-scopes", "key_1", "--scopes", "chat,chat", "--base-url", srv.URL)
	var cliErr *CLIError
	if !errors.As(err, &cliErr) || cliErr.Code != ExitUsage {
		t.Fatalf("expected usage error, got %v", err)
	}
}

func TestKeyUpdateScopes_MapsAPIError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"error":{"code":"NOT_FOUND","message":"missing"}}`))
	}))
	defer srv.Close()
	_, err := runCLI(t, "key", "update-scopes", "missing", "--scopes", "chat", "--base-url", srv.URL)
	var cliErr *CLIError
	if !errors.As(err, &cliErr) || cliErr.Code != ExitNotFound {
		t.Fatalf("expected not found error, got %v", err)
	}
}
