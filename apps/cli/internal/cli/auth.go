package cli

import (
	"fmt"
	"time"

	"github.com/spf13/cobra"
)

// doLogin implements the device-authorization stub from SPEC.md §12.5 /
// §12.2 (`auth login`). It does not perform a real device-auth flow or use
// the OS keyring; it prints the device-auth UX text and writes a local
// session marker so `whoami` has something real to read back, which lets
// this skeleton demonstrate the exit-3 auth error honestly when logged out.
func doLogin(cmd *cobra.Command, args []string, flags map[string]string) error {
	out := cmd.OutOrStdout()
	ctxName := flagContext
	if ctxName == "" {
		ctxName = "default"
	}

	if !flagJSON && !flagQuiet {
		fmt.Fprintln(out, "[STUB] device-authorization flow")
		fmt.Fprintln(out, "  visit https://example.invalid/device and enter code MANI-STUB")
		fmt.Fprintln(out, "  (no real request sent; --base-url was not contacted)")
	}

	s := session{
		Context:   ctxName,
		Workspace: flagWorkspace,
		Principal: "stub-user@local",
		Scopes:    []string{"*:read", "*:write"},
		IssuedAt:  time.Now().UTC(),
	}
	if err := saveSession(s); err != nil {
		return &CLIError{
			Code:        ExitGeneric,
			ErrCode:     "CLI_SESSION_WRITE_FAILED",
			Message:     fmt.Sprintf("could not persist stub session: %v", err),
			Remediation: "check permissions on the manifold config directory",
		}
	}

	return writeResult(cmd, StubResult{
		Schema:  schemaVersion,
		Kind:    "auth.login",
		Command: cmd.CommandPath(),
		Context: ctxName,
		Message: fmt.Sprintf("stub session stored for context %q", ctxName),
	})
}

func doLogout(cmd *cobra.Command, args []string, flags map[string]string) error {
	if err := clearSession(flagContext); err != nil {
		return &CLIError{
			Code:        ExitGeneric,
			ErrCode:     "CLI_SESSION_CLEAR_FAILED",
			Message:     fmt.Sprintf("could not clear stub session: %v", err),
			Remediation: "check permissions on the manifold config directory",
		}
	}
	return writeResult(cmd, StubResult{
		Schema:  schemaVersion,
		Kind:    "auth.logout",
		Command: cmd.CommandPath(),
		Message: "session cleared",
	})
}

func doWhoami(cmd *cobra.Command, args []string, flags map[string]string) error {
	s, err := mustSession()
	if err != nil {
		return err
	}
	return writeResult(cmd, StubResult{
		Schema:  schemaVersion,
		Kind:    "auth.whoami",
		Command: cmd.CommandPath(),
		Context: s.Context,
		Message: fmt.Sprintf("principal=%s workspace=%s scopes=%v issued_at=%s",
			s.Principal, s.Workspace, s.Scopes, s.IssuedAt.Format(time.RFC3339)),
	})
}

func doAuthStatus(cmd *cobra.Command, args []string, flags map[string]string) error {
	s, err := mustSession()
	if err != nil {
		return err
	}
	return writeResult(cmd, StubResult{
		Schema:  schemaVersion,
		Kind:    "auth.status",
		Command: cmd.CommandPath(),
		Context: s.Context,
		Message: fmt.Sprintf("logged in as %s (workspace=%s, scopes=%v, since %s)",
			s.Principal, s.Workspace, s.Scopes, s.IssuedAt.Format(time.RFC3339)),
	})
}

func newLoginCmd() *cobra.Command {
	return buildLeaf(cmdSpec{
		Use:     "login",
		Short:   "device-authorization login (stub; writes a local session marker)",
		Args:    cobra.NoArgs,
		Kind:    "auth.login",
		Special: doLogin,
	})
}

func newWhoamiCmd() *cobra.Command {
	return buildLeaf(cmdSpec{
		Use:     "whoami",
		Short:   "print the current principal + scopes (machine-readable)",
		Args:    cobra.NoArgs,
		Kind:    "auth.whoami",
		Special: doWhoami,
	})
}

func newAuthCmd() *cobra.Command {
	c := branch("auth", "authentication lifecycle (login/logout/status/whoami)")
	c.AddCommand(
		buildLeaf(cmdSpec{Use: "login", Short: "device-authorization flow; stores stub token", Args: cobra.NoArgs, Kind: "auth.login", Special: doLogin}),
		buildLeaf(cmdSpec{Use: "logout", Short: "remove the stub token for the current context", Args: cobra.NoArgs, Kind: "auth.logout", Special: doLogout}),
		buildLeaf(cmdSpec{Use: "status", Short: "who am I, which workspace, token scopes, expiry", Args: cobra.NoArgs, Kind: "auth.status", Special: doAuthStatus}),
		buildLeaf(cmdSpec{Use: "whoami", Short: "machine-readable principal + scopes", Args: cobra.NoArgs, Kind: "auth.whoami", Special: doWhoami}),
	)
	return c
}
