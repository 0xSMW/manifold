package cli

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

// runCLI executes the real root command with args, capturing combined output.
func runCLI(t *testing.T, args ...string) (string, error) {
	t.Helper()
	buf := new(bytes.Buffer)
	r := newRootCmd()
	r.SetOut(buf)
	r.SetErr(buf)
	r.SetArgs(args)
	err := r.Execute()
	return buf.String(), err
}

// The health command makes a REAL HTTP GET to {base-url}/api/v1/health. httptest.Server is a real
// loopback HTTP server (real sockets), so these exercise the actual client path, not a mock.

func TestHealthCheck_RealHTTP_Success(t *testing.T) {
	var gotPath, gotAccept string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		gotPath = req.URL.Path
		gotAccept = req.Header.Get("Accept")
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"status":"ok","revision":"r1"}`))
	}))
	defer srv.Close()

	out, err := runCLI(t, "ping", "--base-url", srv.URL, "--json")
	if err != nil {
		t.Fatalf("health check returned error: %v", err)
	}
	if gotPath != "/api/v1/health" {
		t.Fatalf("CLI hit wrong path: %q (want /api/v1/health)", gotPath)
	}
	if gotAccept != "application/json" {
		t.Fatalf("CLI did not send Accept: application/json, got %q", gotAccept)
	}
	var parsed map[string]any
	if e := json.Unmarshal([]byte(out), &parsed); e != nil {
		t.Fatalf("--json output is not the passed-through server body: %q (%v)", out, e)
	}
	if parsed["status"] != "ok" || parsed["revision"] != "r1" {
		t.Fatalf("passthrough body mismatch: %q", out)
	}
}

func TestHealthCheck_RealHTTP_404(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()
	_, err := runCLI(t, "ping", "--base-url", srv.URL)
	if err == nil {
		t.Fatal("expected a not-found error for HTTP 404, got nil")
	}
}

func TestHealthCheck_RealHTTP_5xx(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = w.Write([]byte("upstream down"))
	}))
	defer srv.Close()
	_, err := runCLI(t, "ping", "--base-url", srv.URL)
	if err == nil {
		t.Fatal("expected an error for HTTP 503, got nil")
	}
	var cliErr *CLIError
	if !errors.As(err, &cliErr) {
		t.Fatalf("expected *CLIError, got %T: %v", err, err)
	}
	if cliErr.ErrCode != "CLI_HEALTH_ERROR_STATUS" {
		t.Fatalf("expected CLI_HEALTH_ERROR_STATUS, got %q", cliErr.ErrCode)
	}
}

func TestHealthCheck_Unreachable(t *testing.T) {
	// Port 1 on loopback refuses ⇒ the real client errors ⇒ CLI_HEALTH_UNREACHABLE.
	_, err := runCLI(t, "ping", "--base-url", "http://127.0.0.1:1")
	if err == nil {
		t.Fatal("expected an unreachable error, got nil")
	}
	var cliErr *CLIError
	if !errors.As(err, &cliErr) {
		t.Fatalf("expected *CLIError, got %T", err)
	}
	if cliErr.ErrCode != "CLI_HEALTH_UNREACHABLE" {
		t.Fatalf("expected CLI_HEALTH_UNREACHABLE, got %q", cliErr.ErrCode)
	}
}
