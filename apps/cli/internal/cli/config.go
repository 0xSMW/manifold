package cli

import (
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"strings"

	"github.com/spf13/cobra"
)

// planConfig issues a REAL POST /api/v1/config/plan (SPEC.md §8.2 plan()),
// building {installationId} from the command's flags. The control plane returns
// the plan (planHash, diff, tripwires); human/quiet mode prints just the
// planHash (the value config apply consumes), while --json passes the full body
// through verbatim.
func planConfig(cmd *cobra.Command, args []string, flags map[string]string) error {
	client, err := mutationClientFromFlags(cmd, flags)
	if err != nil {
		return err
	}
	body, err := client.post("/config/plan", map[string]any{
		"installationId": flags["installation"],
	})
	if err != nil {
		return err
	}
	var parsed struct {
		PlanHash string `json:"planHash"`
	}
	_ = json.Unmarshal(body, &parsed)
	return writeResult(cmd, StubResult{
		Schema:  schemaVersion,
		Kind:    "config.plan",
		Command: cmd.CommandPath(),
		Message: string(body),
	},
		withRawJSON(body),
		withQuiet(parsed.PlanHash),
		withHuman(func(out io.Writer) { fmt.Fprintln(out, parsed.PlanHash) }),
	)
}

// applyConfig issues a REAL POST /api/v1/config/apply (SPEC.md §8.2 apply(),
// §16.2 optimistic concurrency), building {installationId, planHash, approvals?}
// from the command's flags. A stale --plan-hash makes the control plane reply
// 409 CONFIG_PRECONDITION_FAILED, which the shared client maps to exit 5 via
// exitForEnvelopeCode — preserving the documented precondition/conflict
// behavior (SPEC.md §0.3). Destructive changes without matching --approvals
// come back as 422 CONFIG_TRIPWIRE_HELD (exit 9).
func applyConfig(cmd *cobra.Command, args []string, flags map[string]string) error {
	client, err := mutationClientFromFlags(cmd, flags)
	if err != nil {
		return err
	}
	reqBody := map[string]any{
		"installationId": flags["installation"],
		"planHash":       flags["plan-hash"],
	}
	if v := flags["approvals"]; v != "" {
		approvals := []string{}
		for _, a := range strings.Split(v, ",") {
			if a = strings.TrimSpace(a); a != "" {
				approvals = append(approvals, a)
			}
		}
		reqBody["approvals"] = approvals
	}
	resp, err := client.post("/config/apply", reqBody)
	if err != nil {
		return err
	}
	return renderAPIResult(cmd, "config.apply", resp)
}

// activeConfig issues a REAL GET /api/v1/config/active?installationId=... (SPEC.md
// §7.4 boot fallback) and renders the signed snapshot the control plane returns.
func activeConfig(cmd *cobra.Command, args []string, flags map[string]string) error {
	client, err := clientFromFlags(cmd, flags)
	if err != nil {
		return err
	}
	q := url.Values{}
	q.Set("installationId", flags["installation"])
	resp, err := client.get("/config/active?" + q.Encode())
	if err != nil {
		return err
	}
	return renderAPIResult(cmd, "config.active", resp)
}

func rollbackConfig(cmd *cobra.Command, args []string, flags map[string]string) error {
	if err := confirmDestructive(cmd, flags["revision"], "config rollback"); err != nil {
		return err
	}
	client, err := mutationClientFromFlags(cmd, flags)
	if err != nil {
		return err
	}
	resp, err := client.post("/config/rollback", map[string]any{
		"installationId": flags["installation"],
		"revisionId":     flags["revision"],
		"baseConfigHash": flags["base-config-hash"],
	})
	if err != nil {
		return err
	}
	return renderAPIResult(cmd, "config.rollback", resp)
}

func configHistory(cmd *cobra.Command, args []string, flags map[string]string) error {
	client, err := clientFromFlags(cmd, flags)
	if err != nil {
		return err
	}
	q := url.Values{}
	q.Set("installationId", flags["installation"])
	resp, err := client.get("/config/history?" + q.Encode())
	if err != nil {
		return err
	}
	return renderAPIResult(cmd, "config.history", resp)
}

func newConfigCmd() *cobra.Command {
	c := branch("config", "config revisions (routes/policies/prices snapshot)")
	c.AddCommand(
		buildLeaf(cmdSpec{
			Use:   "plan",
			Short: "compute a config plan (diff of pending changes) and print its plan_hash",
			Args:  cobra.NoArgs,
			Flags: []flagSpec{
				{Name: "installation", Required: true, Usage: "installation id to plan for"},
				{Name: "base-url", Usage: "override the global --base-url for this call"},
			},
			Kind:    "config.plan",
			Special: planConfig, // REAL: POST /api/v1/config/plan
		}),
		buildLeaf(cmdSpec{
			Use:   "apply",
			Short: "apply a config plan by hash; a stale --plan-hash yields exit 5 (CONFIG_PRECONDITION_FAILED)",
			Long: `Apply a config plan produced by 'manifold config plan'.

Sends {installationId, planHash, approvals?} to POST /api/v1/config/apply. If
the active revision advanced since the plan was computed, the control plane
replies 409 CONFIG_PRECONDITION_FAILED and the CLI exits 5 (SPEC.md §0.3,
§16.2). Destructive changes require --approvals listing each tripwire ref,
otherwise the control plane replies 422 CONFIG_TRIPWIRE_HELD (also exit 5).`,
			Args: cobra.NoArgs,
			Flags: []flagSpec{
				{Name: "installation", Required: true, Usage: "installation id to apply to"},
				{Name: "plan-hash", Required: true, Usage: "planHash from `config plan` output"},
				{Name: "approvals", Usage: "comma-separated tripwire refs to approve (SPEC.md §8.2)"},
				{Name: "base-url", Usage: "override the global --base-url for this call"},
			},
			Kind:    "config.apply",
			Special: applyConfig, // REAL: POST /api/v1/config/apply
		}),
		buildLeaf(cmdSpec{
			Use:     "rollback",
			Short:   "republish a prior config revision",
			Args:    cobra.NoArgs,
			Flags:   []flagSpec{{Name: "installation", Required: true, Usage: "installation id to roll back"}, {Name: "revision", Required: true, Usage: "revision id to republish"}, {Name: "base-config-hash", Required: true, Usage: "current active content hash from config history"}, {Name: "base-url", Usage: "override the global --base-url for this call"}},
			Kind:    "config.rollback",
			Special: rollbackConfig,
		}),
		buildLeaf(cmdSpec{
			Use:   "active",
			Short: "show the active config revision",
			Args:  cobra.NoArgs,
			Flags: []flagSpec{
				{Name: "installation", Required: true, Usage: "installation id whose active revision to fetch"},
				{Name: "base-url", Usage: "override the global --base-url for this call"},
			},
			Kind:    "config.active",
			Special: activeConfig, // REAL: GET /api/v1/config/active
		}),
		buildLeaf(cmdSpec{Use: "history", Short: "list past config revisions", Args: cobra.NoArgs, Flags: []flagSpec{{Name: "installation", Required: true, Usage: "installation id whose config history to fetch"}, {Name: "base-url", Usage: "override the global --base-url for this call"}}, Kind: "config.history", Special: configHistory}),
	)
	return c
}
