package cli

import (
	"encoding/json"
	"fmt"
	"io"
	"strconv"
	"strings"

	"github.com/spf13/cobra"
)

// mintKey mints a virtual key via a REAL control-plane call: POST {base-url}/api/v1/keys with
// {profileId, scopes?, allowedAppIds?}. The response returns the plaintext EXACTLY ONCE
// (control-plane §9.2) — we render it and keep the "--quiet prints the plaintext" contract from
// SPEC.md §12.10. The plaintext is never persisted locally.
func mintKey(cmd *cobra.Command, args []string, flags map[string]string) error {
	client, err := mutationClientFromFlags(cmd, flags)
	if err != nil {
		return err
	}

	reqBody := map[string]any{"profileId": flags["profile"]}
	if s := flags["scope"]; s != "" {
		reqBody["scopes"] = []string{s}
	}
	if a := flags["app"]; a != "" {
		reqBody["allowedAppIds"] = []string{a}
	}

	body, err := client.post("/keys", reqBody)
	if err != nil {
		return err
	}

	// The mint response body is `{ keyId, displayPrefix, plaintext }` (control-plane keys/route.ts
	// POST). Pull the plaintext for the --quiet line and the human one-shot render.
	var parsed struct {
		Plaintext string `json:"plaintext"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil || strings.TrimSpace(parsed.Plaintext) == "" {
		return copyOnceResponseError("key mint", client.idempotencyKey)
	}

	return writeResult(cmd, StubResult{
		Schema:  schemaVersion,
		Kind:    "key.mint",
		Command: cmd.CommandPath(),
		Message: string(body),
	},
		withQuiet(parsed.Plaintext),
		withRawJSON(body),
		withHuman(func(out io.Writer) {
			fmt.Fprintln(out, "key.mint — this plaintext key is shown once and not stored:")
			fmt.Fprintln(out, "  "+parsed.Plaintext)
		}),
	)
}

// revokeKey revokes a virtual key via a REAL control-plane call: POST
// {base-url}/api/v1/keys/{id}/revoke (control-plane keys/[id]/revoke/route.ts). The route reads no
// body; the id comes from the positional arg. On 2xx the JSON body (`{ id, revoked: true }`) is
// rendered; a §0.3 error envelope maps to the right exit code via the shared client.
func revokeKey(cmd *cobra.Command, args []string, flags map[string]string) error {
	if err := confirmDestructive(cmd, args[0], "key revoke"); err != nil {
		return err
	}
	client, err := mutationClientFromFlags(cmd, flags)
	if err != nil {
		return err
	}
	body, err := client.post("/keys/"+args[0]+"/revoke", nil)
	if err != nil {
		return err
	}
	return renderAPIResult(cmd, "key.revoke", body)
}

func rotateKey(cmd *cobra.Command, args []string, flags map[string]string) error {
	reqBody := map[string]any{}
	if value := flags["grace-seconds"]; value != "" {
		graceSeconds, err := strconv.Atoi(value)
		if err != nil || graceSeconds < 60 || graceSeconds > 86_400 {
			return usageError("--grace-seconds must be an integer between 60 and 86400")
		}
		reqBody["graceSeconds"] = graceSeconds
	}
	client, err := mutationClientFromFlags(cmd, flags)
	if err != nil {
		return err
	}
	body, err := client.post("/keys/"+args[0]+"/rotate", reqBody)
	if err != nil {
		return err
	}
	var parsed struct {
		Plaintext string `json:"plaintext"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil || strings.TrimSpace(parsed.Plaintext) == "" {
		return copyOnceResponseError("key rotation", client.idempotencyKey)
	}
	return writeResult(cmd, StubResult{Schema: schemaVersion, Kind: "key.rotate", Command: cmd.CommandPath(), Message: string(body)}, withRawJSON(body), withQuiet(parsed.Plaintext), withHuman(func(out io.Writer) {
		fmt.Fprintln(out, "key.rotate — this plaintext key is shown once and not stored:")
		fmt.Fprintln(out, "  "+parsed.Plaintext)
	}))
}

// copyOnceResponseError is returned after the control plane accepted a key
// mutation but the one-time plaintext response could not be decoded. The
// idempotency key is deliberately retained so an operator can recover the
// original response without risking a second mutation. It is not a secret and
// is safe for the structured error details rendered by the CLI.
func copyOnceResponseError(operation, idempotencyKey string) *CLIError {
	return &CLIError{
		Code:        ExitGeneric,
		ErrCode:     "CLI_COPY_ONCE_RESPONSE_INVALID",
		Message:     fmt.Sprintf("%s response omitted the copy-once plaintext", operation),
		Remediation: "do not retry with a new idempotency key; retry with the idempotency_key in details or inspect the key inventory",
		Details:     mutationFailureDetails(idempotencyKey),
	}
}

func updateKeyScopes(cmd *cobra.Command, args []string, flags map[string]string) error {
	var scopes []string
	seen := make(map[string]struct{})
	for _, raw := range strings.Split(flags["scopes"], ",") {
		scope := strings.TrimSpace(raw)
		if scope == "" {
			return usageError("--scopes must be a comma-separated list of non-empty scopes")
		}
		if _, duplicate := seen[scope]; duplicate {
			return usageError("--scopes must not contain duplicates")
		}
		seen[scope] = struct{}{}
		scopes = append(scopes, scope)
	}
	client, err := mutationClientFromFlags(cmd, flags)
	if err != nil {
		return err
	}
	body, err := client.patch("/keys/"+args[0], map[string]any{"scopes": scopes})
	if err != nil {
		return err
	}
	return renderAPIResult(cmd, "key.update-scopes", body)
}

func newKeyCmd() *cobra.Command {
	c := branch("key", "virtual keys")
	c.AddCommand(
		// `key list` is REAL: GET {base-url}/api/v1/keys with bearer auth (not a stub echo).
		apiLeafList("key", "/keys", "list keys"),
		leafGet("key", "get a key (metadata only, never the plaintext)"),
		buildLeaf(cmdSpec{
			Use:   "mint",
			Short: "mint a new virtual key; prints the plaintext once",
			Args:  cobra.NoArgs,
			Flags: []flagSpec{
				{Name: "profile", Required: true, Usage: "ingress profile id this key is scoped to"},
				{Name: "scope", Usage: "scope, e.g. chat"},
				{Name: "app", Usage: "app id to attribute usage to"},
				{Name: "base-url", Usage: "override the global --base-url for this call"},
			},
			Kind:    "key.mint",
			Special: mintKey,
		}),
		buildLeaf(cmdSpec{Use: "rotate <id>", Short: "rotate a key and print the successor plaintext once", Args: cobra.ExactArgs(1), Flags: []flagSpec{{Name: "grace-seconds", Usage: "predecessor grace period in seconds (60-86400; default 900)"}, {Name: "base-url", Usage: "override the global --base-url for this call"}}, Kind: "key.rotate", Special: rotateKey}),
		buildLeaf(cmdSpec{
			Use:     "revoke <id>",
			Short:   "revoke a key immediately",
			Args:    cobra.ExactArgs(1),
			Flags:   []flagSpec{{Name: "base-url", Usage: "override the global --base-url for this call"}},
			Kind:    "key.revoke",
			Special: revokeKey,
		}),
		buildLeaf(cmdSpec{
			Use:     "update-scopes <id>",
			Short:   "update a key's scopes",
			Args:    cobra.ExactArgs(1),
			Flags:   []flagSpec{{Name: "scopes", Required: true, Usage: "comma-separated scope list"}, {Name: "base-url", Usage: "override the global --base-url for this call"}},
			Kind:    "key.update-scopes",
			Special: updateKeyScopes,
		}),
	)
	return c
}
