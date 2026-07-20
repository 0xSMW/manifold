package cli

import "github.com/spf13/cobra"

func newModelCmd() *cobra.Command {
	c := branch("model", "model registry (from models.dev, SPEC.md ADR-0009)")
	c.AddCommand(
		leafList("model", "list canonical models"),
		leafGet("model", "get a model"),
		buildLeaf(cmdSpec{Use: "capabilities <id>", Short: "show a model's capability matrix", Args: cobra.ExactArgs(1), Kind: "model.capabilities"}),
		buildLeaf(cmdSpec{
			Use:   "set-override-price <id>",
			Short: "set an operator price override (marks fidelity provider_verified)",
			Args:  cobra.ExactArgs(1),
			Flags: []flagSpec{{Name: "price-per-mtok-microusd", Required: true, Usage: "integer µ$ per 1M tokens"}},
			Kind:  "model.set-override-price",
		}),
		buildLeaf(cmdSpec{Use: "routable", Short: "list models routable in the current workspace", Args: cobra.NoArgs, Kind: "model.routable"}),
	)

	catalog := branch("catalog", "offline registry sync (SPEC.md §11.6)")
	catalog.AddCommand(
		buildLeaf(cmdSpec{Use: "sync", Short: "run/inspect the offline registry sync", Args: cobra.NoArgs, Kind: "model.catalog.sync"}),
	)
	c.AddCommand(catalog)

	return c
}
