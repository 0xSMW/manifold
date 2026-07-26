package cli

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
)

type fakeCredentialStore struct {
	values map[string]string
	setErr error
}

func (f *fakeCredentialStore) key(service, account string) string { return service + ":" + account }
func (f *fakeCredentialStore) Set(service, account, secret string) error {
	if f.setErr != nil {
		return f.setErr
	}
	f.values[f.key(service, account)] = secret
	return nil
}
func (f *fakeCredentialStore) Get(service, account string) (string, error) {
	v, ok := f.values[f.key(service, account)]
	if !ok {
		return "", errors.New("missing")
	}
	return v, nil
}
func (f *fakeCredentialStore) Delete(service, account string) error {
	delete(f.values, f.key(service, account))
	return nil
}

func TestStrictJSONRejectsTrailingValue(t *testing.T) {
	var value map[string]any
	if err := strictJSON([]byte(`{"status":"approved"} {"status":"denied"}`), &value); err == nil {
		t.Fatal("strictJSON accepted a second top-level JSON value")
	}
}

func TestAuthLoginHonorsServerIntervalsAndKeepsTokenOutOfDisk(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("MANIFOLD_CONFIG_DIR", dir)
	oldStore, oldSleep, oldBrowser := credentials, authSleep, authOpenBrowser
	t.Cleanup(func() { credentials, authSleep, authOpenBrowser = oldStore, oldSleep, oldBrowser })
	store := &fakeCredentialStore{values: map[string]string{}}
	credentials = store
	var sleeps []time.Duration
	authSleep = func(_ context.Context, d time.Duration) error { sleeps = append(sleeps, d); return nil }
	authOpenBrowser = func(string) error { t.Fatal("--no-browser must not launch a browser"); return nil }
	polls := 0
	var srv *httptest.Server
	srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch req.URL.Path {
		case "/api/v1/cli-auth/start":
			if req.Header.Get("Authorization") != "" {
				t.Error("start unexpectedly had bearer auth")
			}
			var body map[string]any
			_ = json.NewDecoder(req.Body).Decode(&body)
			if body["workspaceSlug"] != "acme" {
				t.Errorf("workspaceSlug=%v", body["workspaceSlug"])
			}
			_, _ = w.Write([]byte(`{"deviceCode":"mfd_abcdefghijklmnopqrstuvwxyzABCDEF12","userCode":"ABCDE-12345","verificationUri":"` + srv.URL + `/settings?cli_auth=ABCDE-12345","interval":5,"expiresIn":60,"client":"Manifold CLI"}`))
		case "/api/v1/cli-auth/poll":
			polls++
			if polls == 1 {
				_, _ = w.Write([]byte(`{"status":"authorization_pending","interval":5}`))
			} else if polls == 2 {
				_, _ = w.Write([]byte(`{"status":"slow_down","interval":10}`))
			} else {
				_, _ = w.Write([]byte(`{"status":"approved","accessToken":"mf_tok_secret_value","tokenType":"Bearer","scopes":["config:read"]}`))
			}
		default:
			t.Errorf("unexpected path %s", req.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer srv.Close()

	out, err := runCLI(t, "auth", "login", "--workspace-slug", "acme", "--base-url", srv.URL, "--no-browser")
	if err != nil {
		t.Fatalf("login: %v", err)
	}
	if strings.Contains(out, "mf_tok_secret_value") {
		t.Fatalf("token leaked to output: %q", out)
	}
	if got := store.values[store.key(keyringService, keyringAccount("default"))]; got != "mf_tok_secret_value" {
		t.Fatalf("keyring token=%q", got)
	}
	if len(sleeps) != 3 || sleeps[0] != 5*time.Second || sleeps[1] != 5*time.Second || sleeps[2] != 10*time.Second {
		t.Fatalf("poll sleeps=%v", sleeps)
	}
	b, err := os.ReadFile(sessionPath("default"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(b), "mf_tok_secret_value") {
		t.Fatalf("token leaked to metadata: %s", b)
	}
}

func TestAuthLoginDeniedDoesNotStoreCredential(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("MANIFOLD_CONFIG_DIR", dir)
	oldStore, oldSleep := credentials, authSleep
	t.Cleanup(func() { credentials, authSleep = oldStore, oldSleep })
	store := &fakeCredentialStore{values: map[string]string{}}
	credentials = store
	authSleep = func(_ context.Context, _ time.Duration) error { return nil }
	var srv *httptest.Server
	srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if req.URL.Path == "/api/v1/cli-auth/start" {
			_, _ = w.Write([]byte(`{"deviceCode":"mfd_abcdefghijklmnopqrstuvwxyzABCDEF12","userCode":"ABCDE-12345","verificationUri":"` + srv.URL + `/settings?cli_auth=ABCDE-12345","interval":1,"expiresIn":60,"client":"Manifold CLI"}`))
			return
		}
		_, _ = w.Write([]byte(`{"status":"denied"}`))
	}))
	defer srv.Close()
	_, err := runCLI(t, "auth", "login", "--workspace-slug", "acme", "--base-url", srv.URL, "--no-browser")
	var cliErr *CLIError
	if !errors.As(err, &cliErr) || cliErr.Code != ExitAuth || cliErr.ErrCode != "CLI_AUTH_DENIED" {
		t.Fatalf("denied result=%v", err)
	}
	if len(store.values) != 0 {
		t.Fatalf("denied login stored a credential")
	}
	if _, err := os.Stat(sessionPath("default")); !os.IsNotExist(err) {
		t.Fatalf("denied login stored metadata: %v", err)
	}
}
