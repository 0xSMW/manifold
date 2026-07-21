package cli

import (
	"strings"

	"github.com/spf13/cobra"
)

func newProviderCmd() *cobra.Command {
	c := branch("provider", "provider credentials (SPEC.md §12.2)")
	c.AddCommand(
		apiLeafList("provider", "/providers", "list providers"), // REAL: GET /api/v1/providers
		leafGet("provider", "get a provider"),
		buildLeaf(cmdSpec{
			Use:   "create",
			Short: "create a provider credential",
			Args:  cobra.NoArgs,
			Flags: []flagSpec{
				{Name: "provider", Required: true, Usage: "provider id, e.g. openai, anthropic"},
				{Name: "label", Required: true, Usage: "human-readable label for the credential"},
				{Name: "secret", Required: true, Usage: "provider API secret to store (envelope-encrypted server-side)"},
				{Name: "provider-base-url", Usage: "override the provider's API base URL"},
				{Name: "allowed-hosts", Usage: "comma-separated allowlist of egress hosts"},
				{Name: "base-url", Usage: "override the global --base-url for this call"},
			},
			Kind:    "provider.create",
			Special: providerCreateSpecial, // REAL: POST /api/v1/providers
		}),
		buildLeaf(cmdSpec{
			Use:     "validate <id>",
			Short:   "validate a provider credential still works",
			Args:    cobra.ExactArgs(1),
			Flags:   []flagSpec{{Name: "base-url", Usage: "override the global --base-url for this call"}},
			Kind:    "provider.validate",
			Special: providerValidateSpecial, // REAL: POST /api/v1/providers/<id>/validate
		}),
		// STUB: no control-plane route exists for rotating a provider secret
		// (apps/control-plane/app/api/v1/providers/[id]/rotate-secret is absent),
		// so this remains a stub echo rather than inventing an endpoint.
		buildLeaf(cmdSpec{
			Use:     "rotate-secret <id>",
			Aliases: []string{"rotate"},
			Short:   "rotate a provider credential's secret (STUB: no server route yet)",
			Args:    cobra.ExactArgs(1),
			Flags:   []flagSpec{{Name: "secret-stdin", Usage: "read the new secret from stdin"}},
			Kind:    "provider.rotate-secret",
		}),
		// STUB: no control-plane route exists for revoking a provider credential
		// (apps/control-plane/app/api/v1/providers/[id]/revoke and a DELETE handler
		// are both absent), so this remains a stub echo rather than inventing an endpoint.
		buildLeaf(cmdSpec{Use: "revoke <id>", Short: "revoke a provider credential (STUB: no server route yet)", Args: cobra.ExactArgs(1), Kind: "provider.revoke"}),
	)
	return c
}

// providerCreateSpecial issues a REAL POST /api/v1/providers, building the request body
// ({provider,label,secret,baseUrl?,allowedHosts?}) from the command's flags and rendering the
// control-plane JSON response.
func providerCreateSpecial(cmd *cobra.Command, args []string, flags map[string]string) error {
	client, err := clientFromFlags(flags)
	if err != nil {
		return err
	}
	body := map[string]any{
		"provider": flags["provider"],
		"label":    flags["label"],
		"secret":   flags["secret"],
	}
	if v := flags["provider-base-url"]; v != "" {
		body["baseUrl"] = v
	}
	if v := flags["allowed-hosts"]; v != "" {
		hosts := []string{}
		for _, h := range strings.Split(v, ",") {
			if h = strings.TrimSpace(h); h != "" {
				hosts = append(hosts, h)
			}
		}
		body["allowedHosts"] = hosts
	}
	resp, err := client.post("/providers", body)
	if err != nil {
		return err
	}
	return renderAPIResult(cmd, "provider.create", resp)
}

// providerValidateSpecial issues a REAL POST /api/v1/providers/<id>/validate (no request body) and
// renders the control-plane JSON response.
func providerValidateSpecial(cmd *cobra.Command, args []string, flags map[string]string) error {
	client, err := clientFromFlags(flags)
	if err != nil {
		return err
	}
	resp, err := client.post("/providers/"+args[0]+"/validate", nil)
	if err != nil {
		return err
	}
	return renderAPIResult(cmd, "provider.validate", resp)
}
