package cli

import "github.com/spf13/cobra"

// getJob demonstrates the exit-4 not-found path: `job get missing`
// reproduces RESOURCE_NOT_FOUND exactly as a real backend would for an
// unknown job id. Any other id is a successful stub get.
func getJob(cmd *cobra.Command, args []string, flags map[string]string) error {
	if args[0] == "missing" {
		return notFoundError("job", args[0])
	}
	return printStub(cmd, "job.get", args, flags)
}

func newJobCmd() *cobra.Command {
	c := branch("job", "job_ledger operations (ingest retries, reconciliation, config-apply followups)")
	c.AddCommand(
		buildLeaf(cmdSpec{Use: "list", Short: "list jobs", Args: cobra.NoArgs, Kind: "job.list"}),
		buildLeaf(cmdSpec{
			Use:     "get <id>",
			Short:   "get a job; `job get missing` demonstrates exit 4 (RESOURCE_NOT_FOUND)",
			Args:    cobra.ExactArgs(1),
			Kind:    "job.get",
			Special: getJob,
		}),
		buildLeaf(cmdSpec{Use: "retry <id>", Short: "retry a failed job", Args: cobra.ExactArgs(1), Kind: "job.retry"}),
		buildLeaf(cmdSpec{Use: "drain", Short: "drain the job ledger now (same path Cron calls)", Args: cobra.NoArgs, Kind: "job.drain"}),
	)
	return c
}
