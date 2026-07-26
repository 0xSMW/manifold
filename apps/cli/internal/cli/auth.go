package cli

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os/exec"
	"runtime"
	"strings"
	"time"

	"github.com/spf13/cobra"
)

type deviceStartResponse struct {
	DeviceCode      string `json:"deviceCode"`
	UserCode        string `json:"userCode"`
	VerificationURI string `json:"verificationUri"`
	Interval        int    `json:"interval"`
	ExpiresIn       int    `json:"expiresIn"`
	Client          string `json:"client"`
}
type devicePollResponse struct {
	Status      string   `json:"status"`
	Interval    int      `json:"interval"`
	AccessToken string   `json:"accessToken"`
	TokenType   string   `json:"tokenType"`
	Scopes      []string `json:"scopes"`
}

var authSleep = func(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}
var authOpenBrowser = openBrowser

func openBrowser(raw string) error {
	var command string
	var args []string
	switch runtime.GOOS {
	case "darwin":
		command = "open"
		args = []string{raw}
	case "windows":
		command = "rundll32"
		args = []string{"url.dll,FileProtocolHandler", raw}
	default:
		command = "xdg-open"
		args = []string{raw}
	}
	return exec.Command(command, args...).Start()
}

func strictJSON(raw []byte, target any) error {
	d := json.NewDecoder(strings.NewReader(string(raw)))
	d.DisallowUnknownFields()
	if err := d.Decode(target); err != nil {
		return err
	}
	var trailing any
	if err := d.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err != nil {
			return err
		}
		return fmt.Errorf("unexpected trailing JSON")
	}
	return nil
}

func authBaseURL(flags map[string]string) string {
	if value := resolveBaseURL(flags); value != "" {
		return value
	}
	if s, err := loadSession(flagContext); err == nil {
		return s.BaseURL
	}
	return ""
}

func verificationURL(raw, base string) (*url.URL, error) {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return nil, fmt.Errorf("server returned an invalid verification URL")
	}
	baseURL, err := url.Parse(base)
	if err != nil {
		return nil, fmt.Errorf("invalid control-plane base URL")
	}
	if u.Scheme != baseURL.Scheme || !strings.EqualFold(u.Host, baseURL.Host) {
		return nil, fmt.Errorf("verification URL origin does not match the configured control plane")
	}
	return u, nil
}

func doLogin(cmd *cobra.Command, args []string, flags map[string]string) error {
	workspaceSlug := flags["workspace-slug"]
	if workspaceSlug == "" {
		return usageError("missing required flag --workspace-slug")
	}
	baseURL := authBaseURL(flags)
	client, err := newAPIClientContext(cmd.Context(), baseURL, "")
	if err != nil {
		return err
	}
	raw, err := client.post("/cli-auth/start", map[string]any{"workspaceSlug": workspaceSlug, "clientId": flags["client-id"], "scopes": strings.Split(flags["scopes"], ",")})
	if err != nil {
		return err
	}
	var start deviceStartResponse
	if err := strictJSON(raw, &start); err != nil || start.DeviceCode == "" || start.UserCode == "" || start.Interval <= 0 || start.ExpiresIn <= 0 {
		return &CLIError{Code: ExitGeneric, ErrCode: "CLI_AUTH_PROTOCOL_ERROR", Message: "control plane returned an invalid device authorization response"}
	}
	verify, err := verificationURL(start.VerificationURI, baseURL)
	if err != nil {
		return &CLIError{Code: ExitGeneric, ErrCode: "CLI_AUTH_PROTOCOL_ERROR", Message: err.Error()}
	}
	noBrowser, _ := cmd.Flags().GetBool("no-browser")
	if !flagJSON && !flagQuiet {
		fmt.Fprintf(cmd.ErrOrStderr(), "Open %s and enter code %s\n", verify.String(), start.UserCode)
	}
	if !noBrowser && !flagNoInput {
		_ = authOpenBrowser(verify.String())
	}

	interval := time.Duration(start.Interval) * time.Second
	deadline := time.Now().Add(time.Duration(start.ExpiresIn) * time.Second)
	for {
		if err := authSleep(cmd.Context(), interval); err != nil {
			return &CLIError{Code: ExitGeneric, ErrCode: "CLI_AUTH_CANCELLED", Message: "device authorization was cancelled", Remediation: "run `manifold auth login` again"}
		}
		if time.Now().After(deadline) {
			return &CLIError{Code: ExitAuth, ErrCode: "CLI_AUTH_EXPIRED", Message: "device authorization expired", Remediation: "run `manifold auth login` again"}
		}
		raw, err = client.post("/cli-auth/poll", map[string]string{"deviceCode": start.DeviceCode})
		if err != nil {
			if time.Now().Before(deadline) {
				continue
			}
			return err
		}
		var poll devicePollResponse
		if err := strictJSON(raw, &poll); err != nil {
			return &CLIError{Code: ExitGeneric, ErrCode: "CLI_AUTH_PROTOCOL_ERROR", Message: "control plane returned an invalid poll response"}
		}
		switch poll.Status {
		case "authorization_pending", "slow_down":
			if poll.Interval <= 0 {
				return &CLIError{Code: ExitGeneric, ErrCode: "CLI_AUTH_PROTOCOL_ERROR", Message: "control plane returned an invalid polling interval"}
			}
			interval = time.Duration(poll.Interval) * time.Second
		case "denied":
			return &CLIError{Code: ExitAuth, ErrCode: "CLI_AUTH_DENIED", Message: "device authorization was denied", Remediation: "ask a workspace administrator to approve a new request"}
		case "expired":
			return &CLIError{Code: ExitAuth, ErrCode: "CLI_AUTH_EXPIRED", Message: "device authorization expired", Remediation: "run `manifold auth login` again"}
		case "approved":
			if poll.AccessToken == "" || poll.TokenType != "Bearer" {
				return &CLIError{Code: ExitGeneric, ErrCode: "CLI_AUTH_PROTOCOL_ERROR", Message: "control plane returned an invalid approval response"}
			}
			ctxName := flagContext
			if ctxName == "" {
				ctxName = "default"
			}
			ref := keyringAccount(ctxName)
			if err := credentials.Set(keyringService, ref, poll.AccessToken); err != nil {
				return &CLIError{Code: ExitAuth, ErrCode: "CLI_KEYRING_WRITE_FAILED", Message: "could not store the credential in the OS keyring", Remediation: "unlock the OS keyring and run `manifold auth login` again"}
			}
			if err := saveSession(session{Context: ctxName, Workspace: workspaceSlug, BaseURL: strings.TrimRight(baseURL, "/"), Scopes: poll.Scopes, IssuedAt: time.Now().UTC(), KeyringRef: ref}); err != nil {
				_ = credentials.Delete(keyringService, ref)
				return &CLIError{Code: ExitGeneric, ErrCode: "CLI_CONTEXT_WRITE_FAILED", Message: "could not store non-secret context metadata"}
			}
			return writeResult(cmd, StubResult{Schema: schemaVersion, Kind: "auth.login", Command: cmd.CommandPath(), Context: ctxName, Message: "device authorization completed"}, withHuman(func(out io.Writer) { fmt.Fprintln(out, "Logged in. Credential stored in the OS keyring.") }))
		default:
			return &CLIError{Code: ExitGeneric, ErrCode: "CLI_AUTH_PROTOCOL_ERROR", Message: "control plane returned an unknown device authorization state"}
		}
	}
}

func authCredential() (string, *session, error) {
	if flagToken != "" {
		return flagToken, nil, nil
	}
	s, err := loadSession(flagContext)
	if err != nil {
		return "", nil, authError("not logged in", "run `manifold auth login` or pass --token / MANIFOLD_TOKEN for CI")
	}
	token, err := credentials.Get(keyringService, s.KeyringRef)
	if err != nil {
		return "", nil, authError("could not access the stored credential", "unlock the OS keyring or run `manifold auth login` again")
	}
	return token, s, nil
}

func doLogout(cmd *cobra.Command, args []string, flags map[string]string) error {
	token, s, credentialErr := authCredential()
	var remoteErr error
	if credentialErr == nil {
		baseURL := authBaseURL(flags)
		if s != nil && baseURL == "" {
			baseURL = s.BaseURL
		}
		if client, err := newAPIClientContext(cmd.Context(), baseURL, token); err != nil {
			remoteErr = err
		} else {
			_, remoteErr = client.post("/cli-auth/revoke", nil)
		}
	}
	if err := clearSession(flagContext); err != nil {
		return &CLIError{Code: ExitGeneric, ErrCode: "CLI_SESSION_CLEAR_FAILED", Message: fmt.Sprintf("could not clear local credential: %v", err)}
	}
	if remoteErr != nil {
		return &CLIError{Code: ExitGeneric, ErrCode: "CLI_REMOTE_REVOKE_FAILED", Message: "local credential was cleared, but remote token revocation failed", Remediation: "revoke the token in Settings > API tokens", Retryable: true}
	}
	return writeResult(cmd, StubResult{Schema: schemaVersion, Kind: "auth.logout", Command: cmd.CommandPath(), Message: "local credential cleared and remote token revoked"})
}

func doWhoami(cmd *cobra.Command, args []string, flags map[string]string) error {
	token, s, err := authCredential()
	if err != nil {
		return err
	}
	baseURL := authBaseURL(flags)
	if baseURL == "" && s != nil {
		baseURL = s.BaseURL
	}
	client, err := newAPIClientContext(cmd.Context(), baseURL, token)
	if err != nil {
		return err
	}
	raw, err := client.get("/me")
	if err != nil {
		return err
	}
	return writeResult(cmd, StubResult{Schema: schemaVersion, Kind: "auth.whoami", Command: cmd.CommandPath(), Context: flagContext, Message: string(raw)}, withRawJSON(raw), withHuman(func(out io.Writer) { fmt.Fprintln(out, string(raw)) }))
}

func doAuthStatus(cmd *cobra.Command, args []string, flags map[string]string) error {
	_, s, err := authCredential()
	if err != nil {
		return err
	}
	if s == nil {
		return writeResult(cmd, StubResult{Schema: schemaVersion, Kind: "auth.status", Command: cmd.CommandPath(), Message: "using --token / MANIFOLD_TOKEN override; no keyring credential inspected"})
	}
	return writeResult(cmd, StubResult{Schema: schemaVersion, Kind: "auth.status", Command: cmd.CommandPath(), Context: s.Context, Message: fmt.Sprintf("logged in to workspace=%s scopes=%v since %s", s.Workspace, s.Scopes, s.IssuedAt.Format(time.RFC3339))})
}

func newLoginCmd() *cobra.Command {
	c := buildLeaf(cmdSpec{Use: "login", Short: "browser-approved device authorization login", Args: cobra.NoArgs, Flags: []flagSpec{{Name: "workspace-slug", Required: true, Usage: "workspace slug to request authorization for"}, {Name: "scopes", Default: "config:read", Usage: "comma-separated requested scopes"}, {Name: "client-id", Default: "manifold-cli", Usage: "registered CLI client identifier"}}, Kind: "auth.login", Special: doLogin})
	c.Flags().Bool("no-browser", false, "do not attempt to open the verification URL")
	return c
}
func newWhoamiCmd() *cobra.Command {
	return buildLeaf(cmdSpec{Use: "whoami", Short: "print the current token identity and scopes", Args: cobra.NoArgs, Kind: "auth.whoami", Special: doWhoami})
}
func newAuthCmd() *cobra.Command {
	c := branch("auth", "authentication lifecycle (login/logout/status/whoami)")
	c.AddCommand(newLoginCmd(), buildLeaf(cmdSpec{Use: "logout", Short: "revoke and remove the credential for the current context", Args: cobra.NoArgs, Kind: "auth.logout", Special: doLogout}), buildLeaf(cmdSpec{Use: "status", Short: "show the active credential metadata", Args: cobra.NoArgs, Kind: "auth.status", Special: doAuthStatus}), newWhoamiCmd())
	return c
}
