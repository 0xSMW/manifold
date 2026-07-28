package cli

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
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
	if gotPath != "/api/v1/keys" || gotAuth != "Bearer tok_secret" || gotAccept != "application/json" {
		t.Fatalf("request path/auth/accept = %q / %q / %q", gotPath, gotAuth, gotAccept)
	}
	var parsed struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := json.Unmarshal([]byte(out), &parsed); err != nil || len(parsed.Data) != 1 || parsed.Data[0].ID != "vk_1" {
		t.Fatalf("list response = %q, parsed=%#v, err=%v", out, parsed, err)
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
	var cliErr *CLIError
	if !errors.As(err, &cliErr) || cliErr.Code != ExitAuth || cliErr.ErrCode != "UNAUTHENTICATED" {
		t.Fatalf("401 result = %v", err)
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
		t.Fatalf("404 result = %v", err)
	}
}

func TestKeyList_NoBaseURL_UsageError(t *testing.T) {
	t.Setenv("MANIFOLD_API", "")
	_, err := runCLI(t, "key", "list")
	var cliErr *CLIError
	if !errors.As(err, &cliErr) || cliErr.Code != ExitUsage {
		t.Fatalf("no base URL result = %v", err)
	}
}

func TestBareHTTPStatus_MapsToStatusSpecificExit(t *testing.T) {
	cases := []struct {
		name             string
		status, wantExit int
		body             string
	}{
		{"401", http.StatusUnauthorized, ExitAuth, "not authorized"},
		{"403", http.StatusForbidden, ExitAuth, `{"message":"forbidden"}`},
		{"404", http.StatusNotFound, ExitNotFound, "page not found"},
		{"409", http.StatusConflict, ExitPrecondition, "conflict"},
		{"500", http.StatusInternalServerError, ExitServer, "boom"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(tc.status)
				_, _ = w.Write([]byte(tc.body))
			}))
			defer srv.Close()
			_, err := runCLI(t, "key", "list", "--base-url", srv.URL, "--token", "t")
			var cliErr *CLIError
			if !errors.As(err, &cliErr) || cliErr.Code != tc.wantExit {
				t.Fatalf("HTTP %d result = %v", tc.status, err)
			}
		})
	}
}

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
			gotPath, gotAuth = req.URL.Path, req.Header.Get("Authorization")
			_, _ = w.Write([]byte(`{"data":[],"nextCursor":null}`))
		}))
		args := append(append([]string{}, tc.args...), "--base-url", srv.URL, "--token", "tk", "--json")
		_, err := runCLI(t, args...)
		srv.Close()
		if err != nil || gotPath != tc.path || gotAuth != "Bearer tk" {
			t.Fatalf("%v result=%v path=%q auth=%q", tc.args, err, gotPath, gotAuth)
		}
	}
}

type roundTripperFunc func(*http.Request) (*http.Response, error)

func (f roundTripperFunc) RoundTrip(req *http.Request) (*http.Response, error) {
	return f(req)
}

type timeoutReadCloser struct{}

func (timeoutReadCloser) Read([]byte) (int, error) { return 0, context.DeadlineExceeded }
func (timeoutReadCloser) Close() error             { return nil }

func clientWithTransport(transport http.RoundTripper) *apiClient {
	return &apiClient{
		baseURL:        "https://control-plane.test",
		http:           &http.Client{Transport: transport},
		ctx:            context.Background(),
		idempotencyKey: "idem-retry-test",
	}
}

func jsonResponse(status int, body io.ReadCloser) *http.Response {
	return &http.Response{
		StatusCode: status,
		Body:       body,
		Header:     make(http.Header),
	}
}

func TestAPIClientRetry_LaterHTTPEnvelopeOverridesEarlierTransportError(t *testing.T) {
	attempts := 0
	var keys []string
	client := clientWithTransport(roundTripperFunc(func(req *http.Request) (*http.Response, error) {
		attempts++
		keys = append(keys, req.Header.Get("Idempotency-Key"))
		if attempts == 1 {
			return nil, context.DeadlineExceeded
		}
		return jsonResponse(http.StatusUnauthorized, io.NopCloser(strings.NewReader(`{"error":{"code":"UNAUTHENTICATED","message":"expired"}}`))), nil
	}))

	_, err := client.post("/providers", map[string]string{"name": "example"})
	if err == nil {
		t.Fatal("post succeeded, want HTTP envelope error")
	}
	var cliErr *CLIError
	if !errors.As(err, &cliErr) {
		t.Fatalf("error type = %T, want *CLIError", err)
	}
	if cliErr.Code != ExitAuth || cliErr.ErrCode != "UNAUTHENTICATED" {
		t.Fatalf("error = %#v, want UNAUTHENTICATED mapped to ExitAuth", cliErr)
	}
	if attempts != 2 {
		t.Fatalf("attempts = %d, want 2", attempts)
	}
	for i, key := range keys {
		if key != "idem-retry-test" {
			t.Fatalf("attempt %d idempotency key = %q", i+1, key)
		}
	}
}

func TestAPIClientRetry_ResponseReadErrorRetriesWithSameKey(t *testing.T) {
	attempts := 0
	var keys []string
	client := clientWithTransport(roundTripperFunc(func(req *http.Request) (*http.Response, error) {
		attempts++
		keys = append(keys, req.Header.Get("Idempotency-Key"))
		if attempts == 1 {
			return jsonResponse(http.StatusOK, timeoutReadCloser{}), nil
		}
		return jsonResponse(http.StatusCreated, io.NopCloser(strings.NewReader(`{"id":"provider_1"}`))), nil
	}))

	body, err := client.post("/providers", map[string]string{"name": "example"})
	if err != nil {
		t.Fatalf("post failed: %v", err)
	}
	if string(body) != `{"id":"provider_1"}` {
		t.Fatalf("body = %s", body)
	}
	if attempts != 2 {
		t.Fatalf("attempts = %d, want 2", attempts)
	}
	for i, key := range keys {
		if key != "idem-retry-test" {
			t.Fatalf("attempt %d idempotency key = %q", i+1, key)
		}
	}
}

func TestAPIClientRetry_ExhaustedResponseReadTimeoutIsStructuredTimeout(t *testing.T) {
	attempts := 0
	client := clientWithTransport(roundTripperFunc(func(req *http.Request) (*http.Response, error) {
		attempts++
		if key := req.Header.Get("Idempotency-Key"); key != "idem-retry-test" {
			t.Fatalf("attempt %d idempotency key = %q", attempts, key)
		}
		return jsonResponse(http.StatusOK, timeoutReadCloser{}), nil
	}))

	_, err := client.post("/providers", map[string]string{"name": "example"})
	if err == nil {
		t.Fatal("post succeeded, want timeout")
	}
	var cliErr *CLIError
	if !errors.As(err, &cliErr) {
		t.Fatalf("error type = %T, want *CLIError", err)
	}
	if cliErr.Code != ExitTimeout || cliErr.ErrCode != "CLI_TIMEOUT" || !cliErr.Retryable {
		t.Fatalf("error = %#v, want retryable CLI_TIMEOUT", cliErr)
	}
	if cliErr.Details["idempotency_key"] != "idem-retry-test" {
		t.Fatalf("details = %#v, want idempotency key", cliErr.Details)
	}
	if attempts != 3 {
		t.Fatalf("attempts = %d, want 3", attempts)
	}
}
