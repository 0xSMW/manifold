package cli

import "github.com/spf13/cobra"

func newStorageCmd() *cobra.Command {
	c := branch("storage", "storage-bounded mode (SPEC.md §13)")
	c.AddCommand(
		buildLeaf(cmdSpec{Use: "status", Short: "show tier, used_pct, forecast_exhaustion_at", Args: cobra.NoArgs, Kind: "storage.status"}),
		buildLeaf(cmdSpec{Use: "forecast", Short: "forecast exhaustion at current growth rate", Args: cobra.NoArgs, Kind: "storage.forecast"}),
		buildLeaf(cmdSpec{Use: "compact", Short: "run compaction now; reports freed_bytes, new used_pct", Args: cobra.NoArgs, Kind: "storage.compact"}),
		buildLeaf(cmdSpec{
			Use:   "set-thresholds",
			Short: "set the warning/emergency thresholds",
			Args:  cobra.NoArgs,
			Flags: []flagSpec{
				{Name: "warn-pct", Usage: "warning threshold percent"},
				{Name: "emergency-pct", Usage: "emergency threshold percent"},
			},
			Kind: "storage.set-thresholds",
		}),
		buildLeaf(cmdSpec{
			Use:   "export-before-delete",
			Short: "export request detail slated for retention deletion before it is dropped",
			Args:  cobra.NoArgs,
			Flags: []flagSpec{{Name: "dest", Usage: "export destination"}},
			Kind:  "storage.export-before-delete",
		}),
	)
	return c
}
