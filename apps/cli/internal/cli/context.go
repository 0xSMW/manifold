package cli

import "github.com/spf13/cobra"

func newContextCmd() *cobra.Command {
	c := branch("context", "manage CLI contexts/workspaces (SPEC.md §12.6)")
	c.AddCommand(
		buildLeaf(cmdSpec{Use: "list", Short: "list configured contexts", Args: cobra.NoArgs, Kind: "context.list"}),
		buildLeaf(cmdSpec{
			Use:   "use <name>",
			Short: "switch the current context",
			Args:  cobra.ExactArgs(1),
			Kind:  "context.use",
		}),
		buildLeaf(cmdSpec{Use: "show", Short: "show the active context", Args: cobra.NoArgs, Kind: "context.show"}),
		buildLeaf(cmdSpec{
			Use:   "set <k=v> [k=v...]",
			Short: "edit fields on the active context",
			Args:  cobra.MinimumNArgs(1),
			Kind:  "context.set",
		}),
		buildLeaf(cmdSpec{
			Use:   "delete <name>",
			Short: "delete a context",
			Args:  cobra.ExactArgs(1),
			Kind:  "context.delete",
		}),
	)
	return c
}

func newWorkspaceCmd() *cobra.Command {
	c := branch("workspace", "manage workspaces (tenants)")
	c.AddCommand(
		buildLeaf(cmdSpec{Use: "list", Short: "list workspaces", Args: cobra.NoArgs, Kind: "workspace.list"}),
		buildLeaf(cmdSpec{Use: "get <id>", Short: "get a workspace", Args: cobra.ExactArgs(1), Kind: "workspace.get"}),
		buildLeaf(cmdSpec{
			Use:   "update <id>",
			Short: "update a workspace",
			Args:  cobra.ExactArgs(1),
			Flags: []flagSpec{{Name: "name", Usage: "new display name"}},
			Kind:  "workspace.update",
		}),
		buildLeaf(cmdSpec{
			Use:   "set-storage-policy <id>",
			Short: "set the storage-bounded-mode ceiling/thresholds for a workspace (SPEC.md §13)",
			Args:  cobra.ExactArgs(1),
			Flags: []flagSpec{
				{Name: "ceiling-bytes", Usage: "hard durable-size ceiling in bytes"},
				{Name: "warn-pct", Usage: "warning threshold percent"},
				{Name: "emergency-pct", Usage: "emergency threshold percent"},
			},
			Kind: "workspace.set-storage-policy",
		}),
	)
	return c
}
