package cli

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

// The `key list` command is REAL: GET {base}/api/v1/keys with Bearer auth. httptest.Server is a real
// loopback HTTP server (real sockets), so these exercise the actual client, not a mock.

func TestKeyList_RealHTTP_SendsBearerAndRendersData(t *testing.T) {
	var gotAuth, gotPath, gotAccept string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		gotAuth = req.Header.Get("Authorization")
		gotPath = req.URL.Path
		gotAccept = req.Header.Get("Accept")
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"data":[{"id":"vk_1","displayPrefix":"sk-abc"}],"nextCursor":null}`))
	}))
	defer srv.Close()

	out, err := runCLI(t, "key", "list", "--base-url", srv.URL, "--token", "tok_secret", "--json")
	if err != nil {
		t.Fatalf("key list returned error: %v", err)
	}
	if gotPath != "/api/v1/keys" {
		t.Fatalf("hit wrong path: %q (want /api/v1/keys)", gotPath)
	}
	if gotAuth != "Bearer tok_secret" {
		t.Fatalf("bearer auth not sent: %q", gotAuth)
	}
	if gotAccept != "application/json" {
		t.Fatalf("Accept header wrong: %q", gotAccept)
	}
	var parsed struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if e := json.Unmarshal([]byte(out), &parsed); e != nil {
		t.Fatalf("--json output not the passed-through body: %q (%v)", out, e)
	}
	if len(parsed.Data) != 1 || parsed.Data[0].ID != "vk_1" {
		t.Fatalf("list data not rendered: %q", out)
	}
}

func TestKeyList_RealHTTP_401MapsToAuthExit(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"error":{"code":"UNAUTHENTICATED","message":"missing bearer token"}}`))
	}))
	defer srv.Close()

	_, err := runCLI(t, "key", "list", "--base-url", srv.URL)
	if err == nil {
		t.Fatal("expected an auth error for 401, got nil")
	}
	var cliErr *CLIError
	if !errors.As(err, &cliErr) {
		t.Fatalf("expected *CLIError, got %T", err)
	}
	if cliErr.Code != ExitAuth {
		t.Fatalf("401 UNAUTHENTICATED must map to ExitAuth(3), got %d", cliErr.Code)
	}
	if cliErr.ErrCode != "UNAUTHENTICATED" {
		t.Fatalf("expected ErrCode UNAUTHENTICATED, got %q", cliErr.ErrCode)
	}
}

func TestKeyList_RealHTTP_404MapsToNotFoundExit(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"error":{"code":"NOT_FOUND","message":"no such resource"}}`))
	}))
	defer srv.Close()

	_, err := runCLI(t, "key", "list", "--base-url", srv.URL, "--token", "t")
	var cliErr *CLIError
	if !errors.As(err, &cliErr) || cliErr.Code != ExitNotFound {
		t.Fatalf("404 NOT_FOUND must map to ExitNotFound(4); got %v", err)
	}
}

func TestKeyList_NoBaseURL_UsageError(t *testing.T) {
	// With no base URL and no MANIFOLD_API, the real client refuses with a usage error.
	t.Setenv("MANIFOLD_API", "")
	_, err := runCLI(t, "key", "list")
	var cliErr *CLIError
	if !errors.As(err, &cliErr) || cliErr.Code != ExitUsage {
		t.Fatalf("no base URL must be ExitUsage(2); got %v", err)
	}
}

// A bare (non-§0.3-envelope) HTTP error response — no `{"error":{...}}` body — must still map its
// STATUS to the right exit code instead of collapsing to ExitGeneric. Before the fix, any response
// that didn't parse as the envelope (e.g. a plain-text/HTML 401 from a proxy, or a JSON body with no
// `error.code`) fell through to the generic CLI_HTTP_ERROR branch regardless of status.
func TestBareHTTPStatus_MapsToStatusSpecificExit(t *testing.T) {
	cases := []struct {
		name     string
		status   int
		body     string
		wantExit int
	}{
		{"401 no envelope -> ExitAuth", http.StatusUnauthorized, `not authorized`, ExitAuth},
		{"403 no envelope -> ExitAuth", http.StatusForbidden, `{"message":"forbidden"}`, ExitAuth},
		{"404 no envelope -> ExitNotFound", http.StatusNotFound, `page not found`, ExitNotFound},
		{"409 no envelope -> ExitPrecondition", http.StatusConflict, `conflict`, ExitPrecondition},
		{"500 no envelope -> ExitGeneric", http.StatusInternalServerError, `boom`, ExitGeneric},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(tc.status)
				_, _ = w.Write([]byte(tc.body))
			}))
			defer srv.Close()

			_, err := runCLI(t, "key", "list", "--base-url", srv.URL, "--token", "t")
			if err == nil {
				t.Fatalf("expected an error for bare HTTP %d, got nil", tc.status)
			}
			var cliErr *CLIError
			if !errors.As(err, &cliErr) {
				t.Fatalf("expected *CLIError, got %T", err)
			}
			if cliErr.Code != tc.wantExit {
				t.Fatalf("bare HTTP %d must map to exit %d, got %d", tc.status, tc.wantExit, cliErr.Code)
			}
		})
	}
}

// The apiLeafList wiring maps each noun's `list` to the right control-plane path. The client itself is
// verified above; this proves provider/route/key list each hit the correct GET path with bearer auth.
func TestListCommands_HitCorrectPaths(t *testing.T) {
	cases := []struct {
		args []string
		path string
	}{
		{[]string{"key", "list"}, "/api/v1/keys"},
		{[]string{"provider", "list"}, "/api/v1/providers"},
		{[]string{"route", "list"}, "/api/v1/routes"},
	}
	for _, tc := range cases {
		var gotPath, gotAuth string
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			gotPath = req.URL.Path
			gotAuth = req.Header.Get("Authorization")
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"data":[],"nextCursor":null}`))
		}))
		args := append(append([]string{}, tc.args...), "--base-url", srv.URL, "--token", "tk", "--json")
		if _, err := runCLI(t, args...); err != nil {
			srv.Close()
			t.Fatalf("%v returned error: %v", tc.args, err)
		}
		srv.Close()
		if gotPath != tc.path {
			t.Fatalf("%v hit %q, want %q", tc.args, gotPath, tc.path)
		}
		if gotAuth != "Bearer tk" {
			t.Fatalf("%v did not send bearer auth: %q", tc.args, gotAuth)
		}
	}
}
