package cli

import "github.com/spf13/cobra"

func newProviderCmd() *cobra.Command {
	c := branch("provider", "provider credentials (SPEC.md §12.2)")
	c.AddCommand(
		buildLeaf(cmdSpec{Use: "list", Short: "list providers", Args: cobra.NoArgs, Kind: "provider.list"}),
		buildLeaf(cmdSpec{Use: "get <id>", Short: "get a provider", Args: cobra.ExactArgs(1), Kind: "provider.get"}),
		buildLeaf(cmdSpec{
			Use:   "create",
			Short: "create a provider credential",
			Args:  cobra.NoArgs,
			Flags: []flagSpec{
				{Name: "provider", Required: true, Usage: "provider id, e.g. openai, anthropic"},
				{Name: "secret-stdin", Usage: "if set, read the secret from stdin instead of a flag"},
				{Name: "region", Usage: "provider region, if applicable"},
			},
			Kind: "provider.create",
		}),
		buildLeaf(cmdSpec{
			Use:   "validate <id>",
			Short: "validate a provider credential still works",
			Args:  cobra.ExactArgs(1),
			Kind:  "provider.validate",
		}),
		buildLeaf(cmdSpec{
			Use:     "rotate-secret <id>",
			Aliases: []string{"rotate"},
			Short:   "rotate a provider credential's secret",
			Args:    cobra.ExactArgs(1),
			Flags:   []flagSpec{{Name: "secret-stdin", Usage: "read the new secret from stdin"}},
			Kind:    "provider.rotate-secret",
		}),
		buildLeaf(cmdSpec{Use: "revoke <id>", Short: "revoke a provider credential", Args: cobra.ExactArgs(1), Kind: "provider.revoke"}),
	)
	return c
}
