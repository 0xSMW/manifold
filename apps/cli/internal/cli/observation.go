package cli

import "github.com/spf13/cobra"

func observationSubcommands() []*cobra.Command {
	return []*cobra.Command{
		buildLeaf(cmdSpec{
			Use:   "list",
			Short: "list observations",
			Args:  cobra.NoArgs,
			Flags: []flagSpec{
				{Name: "range", Usage: "time range, e.g. 1h, 24h"},
				{Name: "status", Usage: "filter by status, e.g. error"},
				{Name: "fields", Usage: "comma-separated field projection"},
			},
			Kind: "observation.list",
		}),
		buildLeaf(cmdSpec{Use: "get <trace>", Short: "get one observation by trace id", Args: cobra.ExactArgs(1), Kind: "observation.get"}),
		buildLeaf(cmdSpec{
			Use:   "export",
			Short: "stream observations as JSONL",
			Args:  cobra.NoArgs,
			Flags: []flagSpec{{Name: "range", Usage: "time range, e.g. 1h, 24h"}},
			Kind:  "observation.export",
		}),
		buildLeaf(cmdSpec{
			Use:   "annotate <trace>",
			Short: "attach an annotation to an observation",
			Args:  cobra.ExactArgs(1),
			Flags: []flagSpec{{Name: "note", Required: true, Usage: "annotation text"}},
			Kind:  "observation.annotate",
		}),
		buildLeaf(cmdSpec{
			Use:   "feedback <trace>",
			Short: "attach structured feedback to an observation",
			Args:  cobra.ExactArgs(1),
			Flags: []flagSpec{{Name: "score", Usage: "feedback score"}},
			Kind:  "observation.feedback",
		}),
	}
}

func newObservationCmd() *cobra.Command {
	c := branch("observation", "immutable request/response observations")
	c.Aliases = []string{"logs"}
	c.AddCommand(observationSubcommands()...)
	return c
}

func newUsageCmd() *cobra.Command {
	c := branch("usage", "aggregate usage/cost queries")
	c.AddCommand(
		buildLeaf(cmdSpec{
			Use:   "query",
			Short: "aggregate tokens/cost by dimension and grain",
			Args:  cobra.NoArgs,
			Flags: []flagSpec{
				{Name: "dimension", Usage: "e.g. model, app, team, cost-center"},
				{Name: "grain", Usage: "e.g. hour, day, month"},
				{Name: "range", Usage: "time range, e.g. 24h, 30d"},
			},
			Kind: "usage.query",
		}),
	)
	return c
}

func newAuditCmd() *cobra.Command {
	c := branch("audit", "audit log of control-plane changes")
	c.AddCommand(
		buildLeaf(cmdSpec{Use: "list", Short: "list audit entries", Args: cobra.NoArgs, Kind: "audit.list"}),
		buildLeaf(cmdSpec{Use: "export", Short: "export audit entries", Args: cobra.NoArgs, Kind: "audit.export"}),
		buildLeaf(cmdSpec{Use: "verify", Short: "verify the audit log's hash chain", Args: cobra.NoArgs, Kind: "audit.verify"}),
		buildLeaf(cmdSpec{
			Use:   "set-destinations",
			Short: "configure audit export destinations",
			Args:  cobra.NoArgs,
			Flags: []flagSpec{{Name: "destination", Usage: "destination URL or identifier"}},
			Kind:  "audit.set-destinations",
		}),
	)
	return c
}
