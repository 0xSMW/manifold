package cli

import (
	"encoding/json"
	"fmt"
	"io"

	"github.com/spf13/cobra"
)

// mintKey mints a virtual key via a REAL control-plane call: POST {base-url}/api/v1/keys with
// {profileId, scopes?, allowedAppIds?}. The response returns the plaintext EXACTLY ONCE
// (control-plane §9.2) — we render it and keep the "--quiet prints the plaintext" contract from
// SPEC.md §12.10. The plaintext is never persisted locally.
func mintKey(cmd *cobra.Command, args []string, flags map[string]string) error {
	client, err := clientFromFlags(flags)
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
	_ = json.Unmarshal(body, &parsed)

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
	client, err := clientFromFlags(flags)
	if err != nil {
		return err
	}
	body, err := client.post("/keys/"+args[0]+"/revoke", nil)
	if err != nil {
		return err
	}
	return renderAPIResult(cmd, "key.revoke", body)
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
		// `key rotate` is left a STUB: no rotate route exists on the control plane (only POST /keys
		// and POST /keys/{id}/revoke). Do not invent an endpoint.
		buildLeaf(cmdSpec{Use: "rotate <id>", Short: "rotate a key (old key invalidated after grace window)", Args: cobra.ExactArgs(1), Kind: "key.rotate"}),
		buildLeaf(cmdSpec{
			Use:     "revoke <id>",
			Short:   "revoke a key immediately",
			Args:    cobra.ExactArgs(1),
			Flags:   []flagSpec{{Name: "base-url", Usage: "override the global --base-url for this call"}},
			Kind:    "key.revoke",
			Special: revokeKey,
		}),
		// `key update-scopes` is left a STUB: no route exists to update a key's scopes on the control
		// plane. Do not invent an endpoint.
		buildLeaf(cmdSpec{
			Use:   "update-scopes <id>",
			Short: "update a key's scopes",
			Args:  cobra.ExactArgs(1),
			Flags: []flagSpec{{Name: "scopes", Usage: "comma-separated scope list"}},
			Kind:  "key.update-scopes",
		}),
	)
	return c
}
