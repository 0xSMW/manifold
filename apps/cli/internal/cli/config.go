package cli

import "github.com/spf13/cobra"

// applyConfig demonstrates the exit-5 precondition/conflict path from
// SPEC.md §0.3's worked example: passing --plan-hash stale reproduces
// CONFIG_PRECONDITION_FAILED exactly as the control plane would return it
// when the active revision advanced during apply. Any other --plan-hash
// value is treated as a successful stub apply.
func applyConfig(cmd *cobra.Command, args []string, flags map[string]string) error {
	planHash := flags["plan-hash"]
	if planHash == "" {
		return usageError("missing required flag --plan-hash (run `manifold config plan` first)")
	}
	if planHash == "stale" {
		return preconditionError(
			"active revision advanced from sha256:abc… to sha256:def… during apply",
			"re-run `manifold config plan` against the current active revision, then apply",
			map[string]string{"expected": "sha256:abc…", "actual": "sha256:def…"},
		)
	}
	return printStub(cmd, "config.apply", args, flags)
}

func newConfigCmd() *cobra.Command {
	c := branch("config", "config revisions (routes/policies/prices snapshot)")
	c.AddCommand(
		buildLeaf(cmdSpec{
			Use:   "plan",
			Short: "compute a config plan (diff of pending changes) and print its plan_hash",
			Args:  cobra.NoArgs,
			Kind:  "config.plan",
		}),
		buildLeaf(cmdSpec{
			Use:   "apply",
			Short: "apply a config plan by hash; --plan-hash stale demonstrates exit 5 (CONFIG_PRECONDITION_FAILED)",
			Long: `Apply a config plan produced by 'manifold config plan'.

This skeleton demonstrates the precondition/conflict exit code (5) from
SPEC.md §0.3: pass --plan-hash stale to reproduce
CONFIG_PRECONDITION_FAILED exactly as documented. Any other value is
treated as a successful stub apply (exit 0).`,
			Args:    cobra.NoArgs,
			Flags:   []flagSpec{{Name: "plan-hash", Required: true, Usage: "hash from config plan's output"}},
			Kind:    "config.apply",
			Special: applyConfig,
		}),
		buildLeaf(cmdSpec{
			Use:   "rollback",
			Short: "republish a prior config revision",
			Args:  cobra.NoArgs,
			Flags: []flagSpec{{Name: "revision", Required: true, Usage: "revision hash to roll back to"}},
			Kind:  "config.rollback",
		}),
		buildLeaf(cmdSpec{Use: "active", Short: "show the active config revision", Args: cobra.NoArgs, Kind: "config.active"}),
		buildLeaf(cmdSpec{Use: "history", Short: "list past config revisions", Args: cobra.NoArgs, Kind: "config.history"}),
	)
	return c
}
