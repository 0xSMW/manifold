// Package cli implements the manifold command-line skeleton described in
// SPEC.md §12. Every leaf command parses its flags/args and prints a
// structured stub result (respecting --json); no command talks to a real
// control plane yet except `installation health` / `manifold ping`, which
// does a real HTTP GET against --base-url when one is supplied.
package cli

import (
	"fmt"
	"os"

	"github.com/spf13/cobra"
)

// Version is stamped at build time via -ldflags "-X ...Version=...".
// Defaults to "dev" for local builds.
var Version = "dev"

func newRootCmd() *cobra.Command {
	root := &cobra.Command{
		Use:   "manifold",
		Short: "manifold — CLI for the Manifold AI gateway control plane",
		Long: `manifold is the single CLI that manages a Manifold control plane:
providers, routes, keys, policies, budgets, observations, config, storage,
jobs, models, and installations.

This build is a command-surface skeleton (SPEC.md §12): every command
parses its flags and arguments and prints a structured stub result. The
only command that performs a real network call is
'manifold installation health' (alias 'manifold ping'), which pings
--base-url's /api/v1/health endpoint.

Exit codes: 0 ok, 1 generic error, 2 usage error, 3 auth error,
4 not found, 5 precondition/conflict. See 'manifold help exit-codes'.`,
		SilenceUsage:  true,
		SilenceErrors: true,
	}

	root.PersistentFlags().BoolVar(&flagJSON, "json", false, "emit machine-readable JSON instead of human table output")
	root.PersistentFlags().StringVar(&flagContext, "context", os.Getenv("MANIFOLD_CONTEXT"), "named CLI context (config/session profile) to act in (env MANIFOLD_CONTEXT)")
	root.PersistentFlags().StringVar(&flagWorkspace, "workspace", os.Getenv("MANIFOLD_WORKSPACE"), "workspace id, overrides the context's workspace (env MANIFOLD_WORKSPACE)")
	root.PersistentFlags().StringVar(&flagBaseURL, "base-url", os.Getenv("MANIFOLD_API"), "control-plane base URL, overrides the context (env MANIFOLD_API)")
	root.PersistentFlags().BoolVar(&flagNoInput, "no-input", false, "non-interactive: never prompt, error instead (env MANIFOLD_NONINTERACTIVE)")
	root.PersistentFlags().BoolVarP(&flagQuiet, "quiet", "q", false, "only print ids/errors")

	if v := os.Getenv("MANIFOLD_NONINTERACTIVE"); v != "" && v != "0" && v != "false" {
		flagNoInput = true
	}

	root.AddCommand(
		newLoginCmd(),
		newWhoamiCmd(),
		newVersionCmd(),
		newPingCmd(),
		newAuthCmd(),
		newContextCmd(),
		newWorkspaceCmd(),
		newInstallationCmd(),
		newProfileCmd(),
		newProviderCmd(),
		newRouteCmd(),
		newKeyCmd(),
		newAppCmd(),
		newActionCmd(),
		newTeamCmd(),
		newCostCenterCmd(),
		newPolicyCmd(),
		newBudgetCmd(),
		newModelCmd(),
		newObservationCmd(),
		newUsageCmd(),
		newAuditCmd(),
		newConfigCmd(),
		newStorageCmd(),
		newJobCmd(),
		newHealthCmd(),
		newExitCodesHelpCmd(),
	)

	root.CompletionOptions.DisableDefaultCmd = false

	return root
}

// Execute is the CLI entry point called from main(). It maps returned
// errors to the exit codes documented in docs/exit-codes.md and
// SPEC.md §12.4, then calls os.Exit with the right code.
func Execute() {
	root := newRootCmd()
	err := root.Execute()
	if err == nil {
		os.Exit(ExitOK)
	}

	if cliErr, ok := err.(*CLIError); ok {
		printError(cliErr)
		os.Exit(cliErr.Code)
	}

	// Anything else (cobra flag-parsing errors, unknown command, etc.) is a
	// usage error per SPEC.md §12.4.
	generic := &CLIError{
		Code:        ExitUsage,
		ErrCode:     "CLI_USAGE_ERROR",
		Message:     err.Error(),
		Remediation: "run the command with --help to see valid flags and arguments",
	}
	printError(generic)
	os.Exit(generic.Code)
}

// mustSession loads the current session or returns a §12.5-style auth
// error (exit 3) with remediation, for commands that require login.
func mustSession() (*session, error) {
	s, err := loadSession(flagContext)
	if err != nil {
		return nil, authError(
			"not logged in",
			"run `manifold login` (or `manifold auth login`) to authenticate",
		)
	}
	return s, nil
}

func exitCodesText() string {
	return fmt.Sprintf(`Exit codes (SPEC.md §12.4, skeleton subset):

  0   success
  1   generic / unexpected error
  2   usage / validation error (bad flags, bad args, missing required input)
  3   auth error (not logged in, expired/invalid token, missing scope)
  4   not found
  5   precondition failed / conflict (e.g. CONFIG_PRECONDITION_FAILED)

See docs/exit-codes.md for the full table and worked examples.
`)
}
