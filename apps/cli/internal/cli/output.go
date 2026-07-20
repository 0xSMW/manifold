package cli

import (
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strings"

	"github.com/spf13/cobra"
)

// Global persistent flag values, populated by root.go's PersistentFlags and
// read by every leaf command. Kept as package-level state (rather than
// threaded through context.Context) to keep the stub command bodies short —
// this is a single-process, single-invocation CLI so there is no concurrency
// concern.
var (
	flagJSON      bool
	flagContext   string
	flagWorkspace string
	flagBaseURL   string
	flagNoInput   bool
	flagQuiet     bool
)

const schemaVersion = "manifold.v1"

// StubResult is the machine-readable envelope every stub command prints in
// --json mode. It intentionally mirrors the shape described in SPEC.md §12.4
// ({schema, kind, data}) so agents scripting against this skeleton today do
// not have to change their parsing once real handlers land.
type StubResult struct {
	Schema  string            `json:"schema"`
	Kind    string            `json:"kind"`
	Stub    bool              `json:"stub"`
	Command string            `json:"command"`
	Args    []string          `json:"args,omitempty"`
	Flags   map[string]string `json:"flags,omitempty"`
	Context string            `json:"context,omitempty"`
	Message string            `json:"message"`
}

// printStub renders the standard "this command parsed correctly but has no
// backend wired up yet" result, respecting --json/--quiet.
func printStub(cmd *cobra.Command, kind string, args []string, flags map[string]string) error {
	res := StubResult{
		Schema:  schemaVersion,
		Kind:    kind,
		Stub:    true,
		Command: cmd.CommandPath(),
		Args:    args,
		Flags:   flags,
		Context: flagContext,
		Message: fmt.Sprintf("stub: %s parsed successfully; no backend call was made", kind),
	}
	return writeResult(cmd, res)
}

// writeResult prints any JSON-serializable payload as JSON (--json) or as a
// concise human line (default table-ish rendering). --quiet suppresses
// everything but the kind on success.
func writeResult(cmd *cobra.Command, res StubResult) error {
	out := cmd.OutOrStdout()
	if flagQuiet {
		fmt.Fprintln(out, res.Kind)
		return nil
	}
	if flagJSON {
		enc := json.NewEncoder(out)
		enc.SetIndent("", "  ")
		return enc.Encode(res)
	}
	fmt.Fprintf(out, "[STUB] %s\n", res.Kind)
	fmt.Fprintf(out, "  command: %s\n", res.Command)
	if len(res.Args) > 0 {
		fmt.Fprintf(out, "  args:    %s\n", strings.Join(res.Args, " "))
	}
	if len(res.Flags) > 0 {
		keys := make([]string, 0, len(res.Flags))
		for k := range res.Flags {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		parts := make([]string, 0, len(keys))
		for _, k := range keys {
			parts = append(parts, fmt.Sprintf("%s=%s", k, res.Flags[k]))
		}
		fmt.Fprintf(out, "  flags:   %s\n", strings.Join(parts, ", "))
	}
	if res.Context != "" {
		fmt.Fprintf(out, "  context: %s\n", res.Context)
	}
	fmt.Fprintf(out, "  note:    %s\n", res.Message)
	return nil
}

// errorEnvelope is the wire shape from SPEC.md §0.3 / §12.9.
type errorEnvelope struct {
	Schema string       `json:"schema"`
	Kind   string       `json:"kind"`
	Error  errorPayload `json:"error"`
}

type errorPayload struct {
	Code        string            `json:"code"`
	Message     string            `json:"message"`
	Remediation string            `json:"remediation,omitempty"`
	Retryable   bool              `json:"retryable"`
	RequestID   string            `json:"request_id,omitempty"`
	Details     map[string]string `json:"details,omitempty"`
}

// printError renders a CLIError per the agent-safe error contract. Errors go
// to stderr in human mode; in --json mode they are printed as JSON (still to
// stderr, so stdout stays clean for any partial data already written).
func printError(err *CLIError) {
	env := errorEnvelope{
		Schema: schemaVersion,
		Kind:   "error",
		Error: errorPayload{
			Code:        err.ErrCode,
			Message:     err.Message,
			Remediation: err.Remediation,
			Retryable:   err.Retryable,
			Details:     err.Details,
		},
	}
	if flagJSON {
		enc := json.NewEncoder(os.Stderr)
		enc.SetIndent("", "  ")
		_ = enc.Encode(env)
		return
	}
	fmt.Fprintf(os.Stderr, "error: %s\n", err.Message)
	if err.Remediation != "" {
		fmt.Fprintf(os.Stderr, "  remediation: %s\n", err.Remediation)
	}
	fmt.Fprintf(os.Stderr, "  code: %s (exit %d)\n", err.ErrCode, err.Code)
}

// flagString reads a string flag if it was defined on cmd, returning "" if
// absent. Used to build the Flags map for stub output without panicking on
// commands that don't define a given flag.
func flagString(cmd *cobra.Command, name string) (string, bool) {
	f := cmd.Flags().Lookup(name)
	if f == nil {
		return "", false
	}
	return f.Value.String(), true
}
