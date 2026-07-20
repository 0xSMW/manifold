package cli

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"io"

	"github.com/spf13/cobra"
)

// mintKey demonstrates the "prints plaintext once" contract from SPEC.md
// §12.10 without touching a real keystore: it generates a random stub token
// locally, prints it exactly once, and never persists it.
func mintKey(cmd *cobra.Command, args []string, flags map[string]string) error {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return &CLIError{Code: ExitGeneric, ErrCode: "CLI_RANDOM_FAILED", Message: err.Error()}
	}
	stubKey := "mfk_stub_" + hex.EncodeToString(buf)

	return writeResult(cmd, StubResult{
		Schema:  schemaVersion,
		Kind:    "key.mint",
		Command: cmd.CommandPath(),
		Flags:   flags,
		Message: stubKey,
	},
		withQuiet(stubKey),
		withHuman(func(out io.Writer) {
			fmt.Fprintln(out, "[STUB] key.mint — this plaintext key is shown once and not stored:")
			fmt.Fprintln(out, "  "+stubKey)
		}),
	)
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
			},
			Kind:    "key.mint",
			Special: mintKey,
		}),
		buildLeaf(cmdSpec{Use: "rotate <id>", Short: "rotate a key (old key invalidated after grace window)", Args: cobra.ExactArgs(1), Kind: "key.rotate"}),
		buildLeaf(cmdSpec{Use: "revoke <id>", Short: "revoke a key immediately", Args: cobra.ExactArgs(1), Kind: "key.revoke"}),
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
