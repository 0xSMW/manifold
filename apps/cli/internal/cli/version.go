package cli

import (
	"fmt"

	"github.com/spf13/cobra"
)

func newVersionCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "version",
		Short: "print the manifold CLI version",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			if flagJSON {
				return writeResult(cmd, StubResult{
					Schema:  schemaVersion,
					Kind:    "version",
					Command: cmd.CommandPath(),
					Message: Version,
				})
			}
			fmt.Fprintf(cmd.OutOrStdout(), "manifold version %s\n", Version)
			return nil
		},
	}
}

// newExitCodesHelpCmd registers `manifold exit-codes`, which also makes
// `manifold help exit-codes` work since cobra's built-in help command
// resolves topics by looking up a subcommand of that name.
func newExitCodesHelpCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "exit-codes",
		Short: "exit code reference (topic for `manifold help exit-codes`)",
		Long:  exitCodesText(),
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			fmt.Fprint(cmd.OutOrStdout(), exitCodesText())
			return nil
		},
	}
}
