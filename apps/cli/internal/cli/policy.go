package cli

import "github.com/spf13/cobra"

func newPolicyCmd() *cobra.Command {
	c := branch("policy", "policy (entitlements, constraints, capture rules)")
	c.AddCommand(
		buildLeaf(cmdSpec{Use: "list", Short: "list policies", Args: cobra.NoArgs, Kind: "policy.list"}),
		buildLeaf(cmdSpec{Use: "get <id>", Short: "get a policy", Args: cobra.ExactArgs(1), Kind: "policy.get"}),
		buildLeaf(cmdSpec{Use: "revision-add <id>", Short: "add an immutable policy revision", Args: cobra.ExactArgs(1), Kind: "policy.revision-add"}),
		buildLeaf(cmdSpec{
			Use:   "simulate <id>",
			Short: "simulate a policy against a sample request without applying it",
			Args:  cobra.ExactArgs(1),
			Flags: []flagSpec{{Name: "request-file", Usage: "path to a sample request JSON"}},
			Kind:  "policy.simulate",
		}),
		buildLeaf(cmdSpec{
			Use:   "approve <id>",
			Short: "approve a policy revision held by the tripwire",
			Args:  cobra.ExactArgs(1),
			Kind:  "policy.approve",
		}),
	)

	entitlement := branch("entitlement", "model entitlements (scope -> model grants)")
	entitlement.AddCommand(
		buildLeaf(cmdSpec{Use: "list", Short: "list entitlements", Args: cobra.NoArgs, Kind: "policy.entitlement.list"}),
		buildLeaf(cmdSpec{
			Use:   "add",
			Short: "grant an entitlement",
			Args:  cobra.NoArgs,
			Flags: []flagSpec{
				{Name: "scope", Required: true, Usage: "scope, e.g. workspace/team/app"},
				{Name: "model", Required: true, Usage: "canonical model id"},
			},
			Kind: "policy.entitlement.add",
		}),
		buildLeaf(cmdSpec{Use: "remove <id>", Short: "remove an entitlement", Args: cobra.ExactArgs(1), Kind: "policy.entitlement.remove"}),
	)
	c.AddCommand(entitlement)

	constraint := branch("constraint", "request constraints (param clamps/rejects, data region)")
	constraint.AddCommand(
		buildLeaf(cmdSpec{Use: "list", Short: "list constraints", Args: cobra.NoArgs, Kind: "policy.constraint.list"}),
		buildLeaf(cmdSpec{
			Use:   "add",
			Short: "add a constraint",
			Args:  cobra.NoArgs,
			Flags: []flagSpec{
				{Name: "param", Required: true, Usage: "parameter name to constrain"},
				{Name: "max", Usage: "ceiling value"},
			},
			Kind: "policy.constraint.add",
		}),
		buildLeaf(cmdSpec{Use: "remove <id>", Short: "remove a constraint", Args: cobra.ExactArgs(1), Kind: "policy.constraint.remove"}),
	)
	c.AddCommand(constraint)

	return c
}
