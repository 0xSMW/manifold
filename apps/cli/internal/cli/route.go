package cli

import "github.com/spf13/cobra"

func newRouteCmd() *cobra.Command {
	c := branch("route", "gateway routes (public_name -> targets)")
	c.AddCommand(
		leafList("route", "list routes"),
		leafGet("route", "get a route"),
		buildLeaf(cmdSpec{
			Use:   "create",
			Short: "create a route",
			Args:  cobra.NoArgs,
			Flags: []flagSpec{
				{Name: "name", Required: true, Usage: "public_name clients put in the model field"},
				{Name: "endpoint", Required: true, Usage: "chat | responses | embed"},
				{Name: "target", Usage: "provider=...,model=...,weight=... (repeatable in a real impl)"},
			},
			Kind: "route.create",
		}),
		buildLeaf(cmdSpec{
			Use:   "revision-add <id>",
			Short: "add an immutable revision to a route",
			Args:  cobra.ExactArgs(1),
			Kind:  "route.revision-add",
		}),
		buildLeaf(cmdSpec{Use: "set-active <id>", Short: "set the active revision for a route", Args: cobra.ExactArgs(1), Flags: []flagSpec{{Name: "revision", Required: true, Usage: "revision hash to activate"}}, Kind: "route.set-active"}),
		buildLeaf(cmdSpec{
			Use:   "test <id>",
			Short: "dry-run a route against a sample request",
			Args:  cobra.ExactArgs(1),
			Flags: []flagSpec{{Name: "prompt", Usage: "sample prompt text"}},
			Kind:  "route.test",
		}),
		buildLeaf(cmdSpec{Use: "disable <id>", Short: "disable a route", Args: cobra.ExactArgs(1), Kind: "route.disable"}),
		buildLeaf(cmdSpec{
			Use:   "rollback <id>",
			Short: "republish a prior route revision (ADR-0007: rollback is republish, never mutation)",
			Args:  cobra.ExactArgs(1),
			Flags: []flagSpec{{Name: "revision", Required: true, Usage: "revision hash to roll back to"}},
			Kind:  "route.rollback",
		}),
	)

	revision := branch("revision", "route revision history")
	revision.AddCommand(
		buildLeaf(cmdSpec{Use: "list <route-id>", Short: "list revisions for a route", Args: cobra.ExactArgs(1), Kind: "route.revision.list"}),
		buildLeaf(cmdSpec{Use: "get <revision-hash>", Short: "get a revision", Args: cobra.ExactArgs(1), Kind: "route.revision.get"}),
		buildLeaf(cmdSpec{Use: "diff <a> <b>", Short: "diff two revisions", Args: cobra.ExactArgs(2), Kind: "route.revision.diff"}),
		buildLeaf(cmdSpec{Use: "rollback <revision-hash>", Short: "roll a route back to a prior revision", Args: cobra.ExactArgs(1), Kind: "route.revision.rollback"}),
	)
	c.AddCommand(revision)

	return c
}
