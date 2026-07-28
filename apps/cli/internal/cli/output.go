package cli

import (
	"encoding/json"
	"fmt"
	"io"
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
	flagJSON           bool
	flagContext        string
	flagWorkspace      string
	flagBaseURL        string
	flagToken          string
	flagNoInput        bool
	flagQuiet          bool
	flagYes            bool
	flagIdempotencyKey string
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

// resultOpts customizes how writeResult renders a payload in each output
// mode. Commands whose --quiet/--json/human rendering differs from the
// standard stub (version, key mint, installation health) pass these so the
// --quiet/--json precedence lives in exactly one place instead of being
// re-implemented at each call site.
type resultOpts struct {
	quiet   string          // --quiet line; defaults to res.Kind
	human   func(io.Writer) // human-mode renderer; defaults to the stub block
	rawJSON []byte          // if itself valid JSON, emitted verbatim in --json mode
}

type resultOpt func(*resultOpts)

// withQuiet overrides the single line printed in --quiet mode.
func withQuiet(line string) resultOpt {
	return func(o *resultOpts) { o.quiet = line }
}

// withHuman overrides the default human-readable stub block.
func withHuman(fn func(io.Writer)) resultOpt {
	return func(o *resultOpts) { o.human = fn }
}

// withRawJSON passes a body through verbatim in --json mode when it is itself
// valid JSON, so the command is a transparent proxy of an upstream endpoint.
func withRawJSON(b []byte) resultOpt {
	return func(o *resultOpts) { o.rawJSON = b }
}

// writeResult prints any JSON-serializable payload as JSON (--json) or as a
// concise human line (default table-ish rendering). --quiet suppresses
// everything but a single line on success. Options let a few commands
// override each mode's rendering without re-implementing the precedence.
func writeResult(cmd *cobra.Command, res StubResult, opts ...resultOpt) error {
	o := resultOpts{}
	for _, fn := range opts {
		fn(&o)
	}
	out := cmd.OutOrStdout()
	if flagQuiet {
		line := res.Kind
		if o.quiet != "" {
			line = o.quiet
		}
		fmt.Fprintln(out, line)
		return nil
	}
	if flagJSON {
		if o.rawJSON != nil {
			var probe json.RawMessage
			if json.Unmarshal(o.rawJSON, &probe) == nil {
				fmt.Fprintln(out, string(o.rawJSON))
				return nil
			}
		}
		enc := json.NewEncoder(out)
		enc.SetIndent("", "  ")
		return enc.Encode(res)
	}
	if o.human != nil {
		o.human(out)
		return nil
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
	Code        string         `json:"code"`
	Message     string         `json:"message"`
	Remediation string         `json:"remediation,omitempty"`
	Retryable   bool           `json:"retryable"`
	RequestID   string         `json:"request_id,omitempty"`
	Details     map[string]any `json:"details,omitempty"`
	ReasonCodes []string       `json:"reason_codes,omitempty"`
}

// printError renders a CLIError per the agent-safe error contract. Errors go
// to stderr in human mode; in --json mode they are printed as JSON (still to
// stderr, so stdout stays clean for any partial data already written).
func printError(err *CLIError) {
	writeError(os.Stderr, err)
}

// writeError renders a CLIError to an explicit writer. Keeping formatting in
// one place ensures recovery details are identical for the human and JSON
// entry points while allowing callers and tests to capture the agent-safe
// envelope without redirecting process stderr.
func writeError(out io.Writer, err *CLIError) {
	env := errorEnvelope{
		Schema: schemaVersion,
		Kind:   "error",
		Error: errorPayload{
			Code:        err.ErrCode,
			Message:     err.Message,
			Remediation: err.Remediation,
			Retryable:   err.Retryable,
			Details:     redactErrorDetails(err.Details),
			RequestID:   err.RequestID,
			ReasonCodes: err.ReasonCodes,
		},
	}
	if flagJSON {
		enc := json.NewEncoder(out)
		enc.SetIndent("", "  ")
		_ = enc.Encode(env)
		return
	}
	fmt.Fprintf(out, "error: %s\n", err.Message)
	if err.Remediation != "" {
		fmt.Fprintf(out, "  remediation: %s\n", err.Remediation)
	}
	if details := redactErrorDetails(err.Details); len(details) > 0 {
		encoded, _ := json.Marshal(details)
		fmt.Fprintf(out, "  details: %s\n", encoded)
	}
	fmt.Fprintf(out, "  code: %s (exit %d)\n", err.ErrCode, err.Code)
}

func redactErrorDetails(details map[string]any) map[string]any {
	if len(details) == 0 {
		return nil
	}
	redacted := make(map[string]any, len(details))
	for key, value := range details {
		lower := strings.ToLower(key)
		if strings.Contains(lower, "secret") || strings.Contains(lower, "token") || strings.Contains(lower, "plaintext") || strings.Contains(lower, "authorization") {
			redacted[key] = "[REDACTED]"
			continue
		}
		if nested, ok := value.(map[string]any); ok {
			redacted[key] = redactErrorDetails(nested)
		} else {
			redacted[key] = value
		}
	}
	return redacted
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
