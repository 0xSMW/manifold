package cli

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/spf13/cobra"
	keyring "github.com/zalando/go-keyring"
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
	case "CONFIG_PRECONDITION_FAILED", "DUPLICATE_ROUTE":
		return ExitPrecondition
	case "CONFIG_TRIPWIRE_HELD":
		return ExitTripwire
	case "RATE_LIMITED":
		return ExitRateLimited
	case "INTERNAL":
		return ExitServer
	case "VALIDATION":
		return ExitUsage
	default:
		return ExitGeneric
	}
}

// exitForHTTPStatus maps a bare (non-§0.3-envelope) HTTP status to the CLI process exit code, so a
// control-plane error response that isn't shaped as the envelope still surfaces the right exit
// instead of collapsing to ExitGeneric.
func exitForHTTPStatus(status int) int {
	switch status {
	case http.StatusUnauthorized, http.StatusForbidden:
		return ExitAuth
	case http.StatusNotFound:
		return ExitNotFound
	case http.StatusConflict:
		return ExitPrecondition
	case http.StatusTooManyRequests:
		return ExitRateLimited
	case http.StatusRequestTimeout, http.StatusGatewayTimeout:
		return ExitTimeout
	default:
		if status >= 500 && status <= 599 {
			return ExitServer
		}
		return ExitGeneric
	}
}

// apiErrorEnvelope is the control-plane's §0.3 error shape ({ "error": { code, message, ... } }).
type apiErrorEnvelope struct {
	Error struct {
		Code        string         `json:"code"`
		Message     string         `json:"message"`
		ReasonCodes []string       `json:"reason_codes"`
		Remediation string         `json:"remediation"`
		Retryable   bool           `json:"retryable"`
		RequestID   string         `json:"request_id"`
		Details     map[string]any `json:"details"`
	} `json:"error"`
}

// apiClient is the CLI's REAL control-plane HTTP client (Bearer auth, §0.3 envelope handling).
type apiClient struct {
	baseURL        string
	token          string
	http           *http.Client
	ctx            context.Context
	idempotencyKey string
}

func newAPIClient(baseURL, token string) (*apiClient, error) {
	return newAPIClientContext(context.Background(), baseURL, token)
}

func newAPIClientContext(ctx context.Context, baseURL, token string) (*apiClient, error) {
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
		ctx:     ctx,
	}, nil
}

// do issues METHOD {base}/api/v1{path} with an optional JSON body + bearer auth. Returns the raw JSON
// body on 2xx, or a CLIError whose exit code is mapped from the control-plane §0.3 error envelope.
func (c *apiClient) do(method, path string, body any) (json.RawMessage, error) {
	url := c.baseURL + "/api/v1" + path
	var payload []byte
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return nil, &CLIError{Code: ExitGeneric, ErrCode: "CLI_ENCODE_FAILED",
				Message: fmt.Sprintf("could not encode request body: %v", err)}
		}
		payload = b
	}
	attempts := 1
	if c.idempotencyKey != "" {
		attempts = 3
	}
	var raw []byte
	var status int
	var requestErr error
	for attempt := 0; attempt < attempts; attempt++ {
		var rdr io.Reader
		if payload != nil {
			rdr = bytes.NewReader(payload)
		}
		req, err := http.NewRequestWithContext(c.ctx, method, url, rdr)
		if err != nil {
			return nil, &CLIError{Code: ExitGeneric, ErrCode: "CLI_REQUEST_BUILD_FAILED", Message: fmt.Sprintf("could not build request to %s: %v", url, err)}
		}
		req.Header.Set("Accept", "application/json")
		if body != nil {
			req.Header.Set("Content-Type", "application/json")
		}
		if c.token != "" {
			req.Header.Set("Authorization", "Bearer "+c.token)
		}
		if c.idempotencyKey != "" {
			req.Header.Set("Idempotency-Key", c.idempotencyKey)
		}
		resp, err := c.http.Do(req)
		if err != nil {
			requestErr = err
			if attempt+1 < attempts {
				continue
			}
			break
		}
		// A response from a later attempt is authoritative.  In particular, do
		// not let a transport error from an earlier attempt obscure an HTTP
		// result (including its structured error envelope).
		requestErr = nil
		var readErr error
		raw, readErr = io.ReadAll(io.LimitReader(resp.Body, 8<<20))
		status = resp.StatusCode
		resp.Body.Close()
		if readErr != nil {
			if attempt+1 < attempts {
				continue
			}
			if isTimeout(readErr) {
				return nil, timeoutError(method, url, c.idempotencyKey)
			}
			return nil, &CLIError{Code: ExitGeneric, ErrCode: "CLI_RESPONSE_READ_FAILED", Message: fmt.Sprintf("could not read %s %s response: %v", method, url, readErr), Retryable: true, Details: mutationFailureDetails(c.idempotencyKey)}
		}
		if status >= 200 && status < 300 {
			return json.RawMessage(raw), nil
		}
		if attempt+1 < attempts && (status == http.StatusTooManyRequests || status >= 500) {
			continue
		}
		break
	}
	if requestErr != nil {
		if isTimeout(requestErr) {
			return nil, timeoutError(method, url, c.idempotencyKey)
		}
		return nil, &CLIError{Code: ExitGeneric, ErrCode: "CLI_UNREACHABLE", Message: fmt.Sprintf("%s %s failed: %v", method, url, requestErr), Remediation: "confirm the control plane is running and --base-url is reachable", Retryable: true, Details: map[string]any{"idempotency_key": c.idempotencyKey}}
	}
	var env apiErrorEnvelope
	if json.Unmarshal(raw, &env) == nil && env.Error.Code != "" {
		code := exitForEnvelopeCode(env.Error.Code)
		if code == ExitGeneric && status >= 500 && status <= 599 {
			code = exitForHTTPStatus(status)
		}
		return nil, &CLIError{
			Code:        code,
			ErrCode:     env.Error.Code,
			Message:     env.Error.Message,
			Remediation: env.Error.Remediation,
			Retryable:   env.Error.Retryable,
			RequestID:   env.Error.RequestID,
			ReasonCodes: env.Error.ReasonCodes,
			Details:     env.Error.Details,
		}
	}
	return nil, &CLIError{Code: exitForHTTPStatus(status), ErrCode: "CLI_HTTP_ERROR",
		Message: fmt.Sprintf("%s %s returned HTTP %d", method, url, status)}
}

func isTimeout(err error) bool {
	if errors.Is(err, context.DeadlineExceeded) {
		return true
	}
	var netErr net.Error
	return errors.As(err, &netErr) && netErr.Timeout()
}

func timeoutError(method, url, idempotencyKey string) *CLIError {
	return &CLIError{
		Code:        ExitTimeout,
		ErrCode:     "CLI_TIMEOUT",
		Message:     fmt.Sprintf("%s %s timed out", method, url),
		Remediation: "retry with the same --idempotency-key after confirming the control plane is reachable",
		Retryable:   true,
		Details:     mutationFailureDetails(idempotencyKey),
	}
}

func mutationFailureDetails(key string) map[string]any {
	if key == "" {
		return nil
	}
	return map[string]any{"idempotency_key": key}
}

func generatedIdempotencyKey() (string, error) {
	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		return "", err
	}
	value[6] = (value[6] & 0x0f) | 0x40
	value[8] = (value[8] & 0x3f) | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x", value[0:4], value[4:6], value[6:8], value[8:10], value[10:16]), nil
}

// mutationClientFromFlags binds one idempotency key to every attempt for a mutation.
func mutationClientFromFlags(cmd *cobra.Command, flags map[string]string) (*apiClient, error) {
	client, err := clientFromFlags(cmd, flags)
	if err != nil {
		return nil, err
	}
	key := flagIdempotencyKey
	if key == "" {
		key, err = generatedIdempotencyKey()
		if err != nil {
			return nil, &CLIError{Code: ExitGeneric, ErrCode: "CLI_IDEMPOTENCY_KEY_FAILED", Message: fmt.Sprintf("could not generate idempotency key: %v", err)}
		}
	}
	client.idempotencyKey = key
	return client, nil
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
func clientFromFlags(cmd *cobra.Command, flags map[string]string) (*apiClient, error) {
	token := flagToken
	if token == "" {
		if stored, err := tokenForContext(flagContext); err == nil {
			token = stored
		} else if !os.IsNotExist(err) && !errors.Is(err, keyring.ErrNotFound) {
			return nil, authError("could not access the stored credential", "unlock the OS keyring or pass --token / MANIFOLD_TOKEN for CI")
		}
	}
	baseURL := resolveBaseURL(flags)
	if baseURL == "" {
		if s, err := loadSession(flagContext); err == nil {
			baseURL = s.BaseURL
		}
	}
	return newAPIClientContext(cmd.Context(), baseURL, token)
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
		client, err := clientFromFlags(cmd, flags)
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
