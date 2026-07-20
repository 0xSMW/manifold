package cli

import "github.com/spf13/cobra"

// This file groups the smaller attribution/org nouns (app, action, team,
// cost-center) that share the same list/get/create/archive(+update/members)
// shape. A single orgNoun spec + newOrgNoun factory generates each tree so
// the four nouns don't drift out of a shared shape.

// orgNoun describes one attribution/org noun whose CRUD leaves follow a fixed
// shape, differing only in the noun's name, its English article/plural used
// in help text, and which optional verbs (update, membership) it supports.
type orgNoun struct {
	kind     string // command name + Kind prefix, e.g. "cost-center"
	singular string // singular noun for help text, e.g. "cost center"
	plural   string // plural noun for "list <plural>", e.g. "cost centers"
	article  string // "a"/"an" for "get <article> <singular>"
	desc     string // branch Short description
	update   bool   // include `update <id>`
	members  bool   // include `add-member`/`remove-member`
}

// newOrgNoun builds the cobra command tree for one org noun from its spec.
func newOrgNoun(n orgNoun) *cobra.Command {
	subject := n.article + " " + n.singular // e.g. "an app", "a team"

	c := branch(n.kind, n.desc)
	c.AddCommand(
		leafList(n.kind, "list "+n.plural),
		leafGet(n.kind, "get "+subject),
		buildLeaf(cmdSpec{
			Use:   "create",
			Short: "create " + subject,
			Args:  cobra.NoArgs,
			Flags: []flagSpec{{Name: "name", Required: true, Usage: n.singular + " display name"}},
			Kind:  n.kind + ".create",
		}),
	)
	if n.update {
		c.AddCommand(buildLeaf(cmdSpec{
			Use:   "update <id>",
			Short: "update " + subject,
			Args:  cobra.ExactArgs(1),
			Flags: []flagSpec{{Name: "name", Usage: "new display name"}},
			Kind:  n.kind + ".update",
		}))
	}
	c.AddCommand(buildLeaf(cmdSpec{
		Use:   "archive <id>",
		Short: "archive " + subject,
		Args:  cobra.ExactArgs(1),
		Kind:  n.kind + ".archive",
	}))
	if n.members {
		c.AddCommand(
			buildLeaf(cmdSpec{
				Use:   "add-member <id>",
				Short: "add a member to " + subject,
				Args:  cobra.ExactArgs(1),
				Flags: []flagSpec{{Name: "user", Required: true, Usage: "user id or email"}},
				Kind:  n.kind + ".add-member",
			}),
			buildLeaf(cmdSpec{
				Use:   "remove-member <id>",
				Short: "remove a member from " + subject,
				Args:  cobra.ExactArgs(1),
				Flags: []flagSpec{{Name: "user", Required: true, Usage: "user id or email"}},
				Kind:  n.kind + ".remove-member",
			}),
		)
	}
	return c
}

func newAppCmd() *cobra.Command {
	return newOrgNoun(orgNoun{
		kind: "app", singular: "app", plural: "apps", article: "an",
		desc: "applications (attribution scope)",
	})
}

func newActionCmd() *cobra.Command {
	return newOrgNoun(orgNoun{
		kind: "action", singular: "action", plural: "actions", article: "an",
		desc: "actions (attribution scope)",
	})
}

func newTeamCmd() *cobra.Command {
	return newOrgNoun(orgNoun{
		kind: "team", singular: "team", plural: "teams", article: "a",
		desc: "teams (attribution scope + membership)", update: true, members: true,
	})
}

func newCostCenterCmd() *cobra.Command {
	return newOrgNoun(orgNoun{
		kind: "cost-center", singular: "cost center", plural: "cost centers", article: "a",
		desc: "cost centers (budget scope)", update: true,
	})
}
