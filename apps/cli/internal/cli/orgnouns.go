package cli

import "github.com/spf13/cobra"

// This file groups the smaller attribution/org nouns (app, action, team,
// cost-center) that share the same list/get/create/archive(+update/members)
// shape, to avoid four near-identical files.

func newAppCmd() *cobra.Command {
	c := branch("app", "applications (attribution scope)")
	c.AddCommand(
		buildLeaf(cmdSpec{Use: "list", Short: "list apps", Args: cobra.NoArgs, Kind: "app.list"}),
		buildLeaf(cmdSpec{Use: "get <id>", Short: "get an app", Args: cobra.ExactArgs(1), Kind: "app.get"}),
		buildLeaf(cmdSpec{
			Use:   "create",
			Short: "create an app",
			Args:  cobra.NoArgs,
			Flags: []flagSpec{{Name: "name", Required: true, Usage: "app display name"}},
			Kind:  "app.create",
		}),
		buildLeaf(cmdSpec{Use: "archive <id>", Short: "archive an app", Args: cobra.ExactArgs(1), Kind: "app.archive"}),
	)
	return c
}

func newActionCmd() *cobra.Command {
	c := branch("action", "actions (attribution scope)")
	c.AddCommand(
		buildLeaf(cmdSpec{Use: "list", Short: "list actions", Args: cobra.NoArgs, Kind: "action.list"}),
		buildLeaf(cmdSpec{Use: "get <id>", Short: "get an action", Args: cobra.ExactArgs(1), Kind: "action.get"}),
		buildLeaf(cmdSpec{
			Use:   "create",
			Short: "create an action",
			Args:  cobra.NoArgs,
			Flags: []flagSpec{{Name: "name", Required: true, Usage: "action display name"}},
			Kind:  "action.create",
		}),
		buildLeaf(cmdSpec{Use: "archive <id>", Short: "archive an action", Args: cobra.ExactArgs(1), Kind: "action.archive"}),
	)
	return c
}

func newTeamCmd() *cobra.Command {
	c := branch("team", "teams (attribution scope + membership)")
	c.AddCommand(
		buildLeaf(cmdSpec{Use: "list", Short: "list teams", Args: cobra.NoArgs, Kind: "team.list"}),
		buildLeaf(cmdSpec{Use: "get <id>", Short: "get a team", Args: cobra.ExactArgs(1), Kind: "team.get"}),
		buildLeaf(cmdSpec{
			Use:   "create",
			Short: "create a team",
			Args:  cobra.NoArgs,
			Flags: []flagSpec{{Name: "name", Required: true, Usage: "team display name"}},
			Kind:  "team.create",
		}),
		buildLeaf(cmdSpec{
			Use:   "update <id>",
			Short: "update a team",
			Args:  cobra.ExactArgs(1),
			Flags: []flagSpec{{Name: "name", Usage: "new display name"}},
			Kind:  "team.update",
		}),
		buildLeaf(cmdSpec{Use: "archive <id>", Short: "archive a team", Args: cobra.ExactArgs(1), Kind: "team.archive"}),
		buildLeaf(cmdSpec{
			Use:   "add-member <id>",
			Short: "add a member to a team",
			Args:  cobra.ExactArgs(1),
			Flags: []flagSpec{{Name: "user", Required: true, Usage: "user id or email"}},
			Kind:  "team.add-member",
		}),
		buildLeaf(cmdSpec{
			Use:   "remove-member <id>",
			Short: "remove a member from a team",
			Args:  cobra.ExactArgs(1),
			Flags: []flagSpec{{Name: "user", Required: true, Usage: "user id or email"}},
			Kind:  "team.remove-member",
		}),
	)
	return c
}

func newCostCenterCmd() *cobra.Command {
	c := branch("cost-center", "cost centers (budget scope)")
	c.AddCommand(
		buildLeaf(cmdSpec{Use: "list", Short: "list cost centers", Args: cobra.NoArgs, Kind: "cost-center.list"}),
		buildLeaf(cmdSpec{Use: "get <id>", Short: "get a cost center", Args: cobra.ExactArgs(1), Kind: "cost-center.get"}),
		buildLeaf(cmdSpec{
			Use:   "create",
			Short: "create a cost center",
			Args:  cobra.NoArgs,
			Flags: []flagSpec{{Name: "name", Required: true, Usage: "cost center display name"}},
			Kind:  "cost-center.create",
		}),
		buildLeaf(cmdSpec{
			Use:   "update <id>",
			Short: "update a cost center",
			Args:  cobra.ExactArgs(1),
			Flags: []flagSpec{{Name: "name", Usage: "new display name"}},
			Kind:  "cost-center.update",
		}),
		buildLeaf(cmdSpec{Use: "archive <id>", Short: "archive a cost center", Args: cobra.ExactArgs(1), Kind: "cost-center.archive"}),
	)
	return c
}
