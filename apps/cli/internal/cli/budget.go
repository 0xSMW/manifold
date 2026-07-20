package cli

import "github.com/spf13/cobra"

func newBudgetCmd() *cobra.Command {
	c := branch("budget", "budget accounts (spend/token caps)")
	c.AddCommand(
		leafList("budget", "list budgets"),
		leafGet("budget", "get a budget"),
		buildLeaf(cmdSpec{
			Use:   "create",
			Short: "create a budget account",
			Args:  cobra.NoArgs,
			Flags: []flagSpec{
				{Name: "scope", Required: true, Usage: "workspace | team | app | cost-center"},
				{Name: "scope-id", Required: true, Usage: "id of the scoped resource"},
				{Name: "unit", Required: true, Usage: "cost_microusd | tokens"},
				{Name: "window", Required: true, Usage: "daily | monthly | ..."},
				{Name: "limit", Required: true, Usage: "integer limit in the given unit"},
				{Name: "enforcement", Default: "advisory", Usage: "advisory | hard"},
			},
			Kind: "budget.create",
		}),
		buildLeaf(cmdSpec{
			Use:   "update <id>",
			Short: "update a budget account",
			Args:  cobra.ExactArgs(1),
			Flags: []flagSpec{{Name: "limit", Usage: "new limit"}},
			Kind:  "budget.update",
		}),
		buildLeaf(cmdSpec{
			Use:   "allocate <id>",
			Short: "allocate/reallocate spend within a parent budget",
			Args:  cobra.ExactArgs(1),
			Flags: []flagSpec{{Name: "amount", Required: true, Usage: "amount to allocate, in the budget's unit"}},
			Kind:  "budget.allocate",
		}),
		buildLeaf(cmdSpec{
			Use:   "forecast <id>",
			Short: "forecast when a budget will be exhausted at current burn rate",
			Args:  cobra.ExactArgs(1),
			Kind:  "budget.forecast",
		}),
		buildLeaf(cmdSpec{Use: "reservations <id>", Short: "list open reservations against a hard budget", Args: cobra.ExactArgs(1), Kind: "budget.reservations"}),
	)
	return c
}
