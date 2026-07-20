package cli

import (
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/spf13/cobra"
)

const healthTimeout = 5 * time.Second

// pingBaseURL performs the one real network call in this skeleton: a GET
// {base-url}/api/v1/health with a 5s timeout. With no base URL configured it
// falls back to the standard stub output instead of erroring, since a fresh
// checkout has nothing to point at yet.
func pingBaseURL(cmd *cobra.Command, args []string, flags map[string]string) error {
	baseURL := flagBaseURL
	if v, ok := flags["base-url"]; ok && v != "" {
		baseURL = v
	}
	if baseURL == "" {
		return printStub(cmd, "installation.health", args, flags)
	}

	url := strings.TrimRight(baseURL, "/") + "/api/v1/health"
	client := &http.Client{Timeout: healthTimeout}

	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return &CLIError{
			Code:        ExitGeneric,
			ErrCode:     "CLI_REQUEST_BUILD_FAILED",
			Message:     fmt.Sprintf("could not build request to %s: %v", url, err),
			Remediation: "check --base-url is a valid URL",
		}
	}
	req.Header.Set("Accept", "application/json")

	resp, err := client.Do(req)
	if err != nil {
		return &CLIError{
			Code:        ExitGeneric,
			ErrCode:     "CLI_HEALTH_UNREACHABLE",
			Message:     fmt.Sprintf("GET %s failed: %v", url, err),
			Remediation: "confirm the control plane is running and --base-url is reachable",
			Retryable:   true,
		}
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))

	if resp.StatusCode == http.StatusNotFound {
		return notFoundError("installation", url)
	}
	if resp.StatusCode >= 400 {
		return &CLIError{
			Code:        ExitGeneric,
			ErrCode:     "CLI_HEALTH_ERROR_STATUS",
			Message:     fmt.Sprintf("GET %s returned HTTP %d", url, resp.StatusCode),
			Remediation: "check control-plane logs; this is not a CLI bug",
			Details:     map[string]string{"status": fmt.Sprintf("%d", resp.StatusCode), "body": string(body)},
		}
	}

	// --quiet prints "ok"; --json re-emits the server body as-is when it is
	// valid JSON (transparent pass-through) and otherwise wraps it in a stub
	// envelope; human mode shows the request/status/body.
	return writeResult(cmd, StubResult{
		Schema:  schemaVersion,
		Kind:    "installation.health",
		Command: cmd.CommandPath(),
		Message: string(body),
	},
		withQuiet("ok"),
		withRawJSON(body),
		withHuman(func(out io.Writer) {
			fmt.Fprintf(out, "GET %s -> %d\n%s\n", url, resp.StatusCode, string(body))
		}),
	)
}

func newHealthCmd() *cobra.Command {
	c := branch("health", "deployment diagnostics / readiness")
	c.AddCommand(buildLeaf(cmdSpec{
		Use:   "check",
		Short: "check control-plane health (real HTTP call if --base-url is set)",
		Args:  cobra.NoArgs,
		Flags: []flagSpec{
			{Name: "base-url", Usage: "override the global --base-url for this call"},
		},
		Kind:    "health.check",
		Special: pingBaseURL,
	}))
	return c
}

// newPingCmd is a convenience top-level alias for `installation health` /
// `health check`, since it's the one command in this skeleton that hits a
// real deployment.
func newPingCmd() *cobra.Command {
	return buildLeaf(cmdSpec{
		Use:   "ping",
		Short: "alias for `manifold installation health`: GET {base-url}/api/v1/health",
		Args:  cobra.NoArgs,
		Flags: []flagSpec{
			{Name: "base-url", Usage: "override the global --base-url for this call"},
		},
		Kind:    "installation.health",
		Special: pingBaseURL,
	})
}
