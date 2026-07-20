package cli

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/spf13/cobra"
)

const apiTimeout = 15 * time.Second

// exitForEnvelopeCode maps a control-plane §0.3 error-envelope `code` to the CLI process exit code
// so scripts/agents can branch on the exit status.
func exitForEnvelopeCode(code string) int {
	switch code {
	case "UNAUTHENTICATED", "FORBIDDEN":
		return ExitAuth
	case "NOT_FOUND", "RESOURCE_NOT_FOUND", "OFFERING_NOT_FOUND":
		return ExitNotFound
	case "CONFIG_PRECONDITION_FAILED", "CONFIG_TRIPWIRE_HELD", "DUPLICATE_ROUTE":
		return ExitPrecondition
	case "VALIDATION":
		return ExitUsage
	default:
		return ExitGeneric
	}
}

// apiErrorEnvelope is the control-plane's §0.3 error shape ({ "error": { code, message, ... } }).
type apiErrorEnvelope struct {
	Error struct {
		Code        string   `json:"code"`
		Message     string   `json:"message"`
		ReasonCodes []string `json:"reason_codes"`
		Remediation string   `json:"remediation"`
		Retryable   bool     `json:"retryable"`
	} `json:"error"`
}

// apiClient is the CLI's REAL control-plane HTTP client (Bearer auth, §0.3 envelope handling).
type apiClient struct {
	baseURL string
	token   string
	http    *http.Client
}

func newAPIClient(baseURL, token string) (*apiClient, error) {
	if baseURL == "" {
		return nil, &CLIError{
			Code:        ExitUsage,
			ErrCode:     "CLI_NO_BASE_URL",
			Message:     "no control-plane base URL configured",
			Remediation: "pass --base-url or set MANIFOLD_API",
		}
	}
	return &apiClient{
		baseURL: strings.TrimRight(baseURL, "/"),
		token:   token,
		http:    &http.Client{Timeout: apiTimeout},
	}, nil
}

// do issues METHOD {base}/api/v1{path} with an optional JSON body + bearer auth. Returns the raw JSON
// body on 2xx, or a CLIError whose exit code is mapped from the control-plane §0.3 error envelope.
func (c *apiClient) do(method, path string, body any) (json.RawMessage, error) {
	url := c.baseURL + "/api/v1" + path
	var rdr io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return nil, &CLIError{Code: ExitGeneric, ErrCode: "CLI_ENCODE_FAILED",
				Message: fmt.Sprintf("could not encode request body: %v", err)}
		}
		rdr = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, url, rdr)
	if err != nil {
		return nil, &CLIError{Code: ExitGeneric, ErrCode: "CLI_REQUEST_BUILD_FAILED",
			Message: fmt.Sprintf("could not build request to %s: %v", url, err)}
	}
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if c.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, &CLIError{Code: ExitGeneric, ErrCode: "CLI_UNREACHABLE",
			Message:     fmt.Sprintf("%s %s failed: %v", method, url, err),
			Remediation: "confirm the control plane is running and --base-url is reachable",
			Retryable:   true}
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		return json.RawMessage(raw), nil
	}
	var env apiErrorEnvelope
	if json.Unmarshal(raw, &env) == nil && env.Error.Code != "" {
		return nil, &CLIError{
			Code:        exitForEnvelopeCode(env.Error.Code),
			ErrCode:     env.Error.Code,
			Message:     env.Error.Message,
			Remediation: env.Error.Remediation,
			Retryable:   env.Error.Retryable,
		}
	}
	return nil, &CLIError{Code: ExitGeneric, ErrCode: "CLI_HTTP_ERROR",
		Message: fmt.Sprintf("%s %s returned HTTP %d", method, url, resp.StatusCode)}
}

// get/post/patch/del are the REST verb wrappers over do (bearer auth + §0.3 envelope handling).
func (c *apiClient) get(path string) (json.RawMessage, error) { return c.do(http.MethodGet, path, nil) }
func (c *apiClient) post(path string, b any) (json.RawMessage, error) {
	return c.do(http.MethodPost, path, b)
}
func (c *apiClient) patch(path string, b any) (json.RawMessage, error) {
	return c.do(http.MethodPatch, path, b)
}
func (c *apiClient) del(path string) (json.RawMessage, error) {
	return c.do(http.MethodDelete, path, nil)
}

// clientFromFlags builds an authed client from the per-command --base-url (else global) + --token.
func clientFromFlags(flags map[string]string) (*apiClient, error) {
	return newAPIClient(resolveBaseURL(flags), flagToken)
}

// renderAPIResult writes a JSON body: --json passes it through; human mode prints it.
func renderAPIResult(cmd *cobra.Command, kind string, body json.RawMessage) error {
	return writeResult(cmd, StubResult{
		Schema:  schemaVersion,
		Kind:    kind,
		Command: cmd.CommandPath(),
		Message: string(body),
	},
		withRawJSON(body),
		withHuman(func(out io.Writer) { fmt.Fprintln(out, string(body)) }),
	)
}

// resolveBaseURL prefers a per-command --base-url flag, else the global.
func resolveBaseURL(flags map[string]string) string {
	if v, ok := flags["base-url"]; ok && v != "" {
		return v
	}
	return flagBaseURL
}

// apiListSpecial returns a Special func that GETs an API path and renders the JSON body (real HTTP,
// not a stub). --json passes the body through; human mode prints it.
func apiListSpecial(apiPath, kind string) specialFunc {
	return func(cmd *cobra.Command, args []string, flags map[string]string) error {
		client, err := newAPIClient(resolveBaseURL(flags), flagToken)
		if err != nil {
			return err
		}
		body, err := client.get(apiPath)
		if err != nil {
			return err
		}
		return writeResult(cmd, StubResult{
			Schema:  schemaVersion,
			Kind:    kind,
			Command: cmd.CommandPath(),
			Message: string(body),
		},
			withRawJSON(body),
			withHuman(func(out io.Writer) { fmt.Fprintln(out, string(body)) }),
		)
	}
}

// apiLeafList builds a "<noun> list" command backed by a REAL GET {apiPath} (not a stub echo). It
// also accepts a per-command --base-url override, like the health command.
func apiLeafList(noun, apiPath, short string) *cobra.Command {
	return buildLeaf(cmdSpec{
		Use:     "list",
		Short:   short,
		Args:    cobra.NoArgs,
		Flags:   []flagSpec{{Name: "base-url", Usage: "override the global --base-url for this call"}},
		Kind:    noun + ".list",
		Special: apiListSpecial(apiPath, noun+".list"),
	})
}
