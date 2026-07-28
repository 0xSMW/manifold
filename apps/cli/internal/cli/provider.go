package cli

import (
	"bufio"
	"fmt"
	"io"
	"os"
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
				{Name: "secret", Usage: "provider API secret (discouraged: visible in argv)"},
				{Name: "secret-stdin", Boolean: true, Usage: "read the provider API secret from stdin"},
				{Name: "secret-env", Usage: "environment variable containing the provider API secret"},
				{Name: "secret-file", Usage: "file containing the provider API secret"},
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
		buildLeaf(cmdSpec{
			Use:     "rotate-secret <id>",
			Aliases: []string{"rotate"},
			Short:   "rotate a provider credential's secret",
			Args:    cobra.ExactArgs(1),
			Flags: []flagSpec{
				{Name: "secret", Usage: "new provider API secret"},
				{Name: "secret-stdin", Boolean: true, Usage: "read the new secret from stdin"},
				{Name: "base-url", Usage: "override the global --base-url for this call"},
			},
			Kind:    "provider.rotate-secret",
			Special: providerRotateSecretSpecial,
		}),
		buildLeaf(cmdSpec{Use: "revoke <id>", Short: "revoke a provider credential", Args: cobra.ExactArgs(1), Flags: []flagSpec{{Name: "base-url", Usage: "override the global --base-url for this call"}}, Kind: "provider.revoke", Special: providerRevokeSpecial}),
	)
	return c
}

// providerCreateSpecial issues a REAL POST /api/v1/providers, building the request body
// ({provider,label,secret,baseUrl?,allowedHosts?}) from the command's flags and rendering the
// control-plane JSON response.
func providerCreateSpecial(cmd *cobra.Command, args []string, flags map[string]string) error {
	client, err := mutationClientFromFlags(cmd, flags)
	if err != nil {
		return err
	}
	secret, err := providerSecret(cmd, flags)
	if err != nil {
		return err
	}
	if secret == "" {
		return usageError("provider secret must not be empty")
	}
	body := map[string]any{
		"provider": flags["provider"],
		"label":    flags["label"],
		"secret":   secret,
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
	client, err := mutationClientFromFlags(cmd, flags)
	if err != nil {
		return err
	}
	resp, err := client.post("/providers/"+args[0]+"/validate", nil)
	if err != nil {
		return err
	}
	return renderAPIResult(cmd, "provider.validate", resp)
}

func providerRotateSecretSpecial(cmd *cobra.Command, args []string, flags map[string]string) error {
	fromStdin := cmd.Flags().Changed("secret-stdin")
	secret := flags["secret"]
	if fromStdin && secret != "" {
		return usageError("pass exactly one of --secret or --secret-stdin")
	}
	if fromStdin {
		value, err := io.ReadAll(cmd.InOrStdin())
		if err != nil {
			return &CLIError{Code: ExitGeneric, ErrCode: "CLI_SECRET_READ_FAILED", Message: fmt.Sprintf("could not read provider secret from stdin: %v", err)}
		}
		secret = strings.TrimSuffix(strings.TrimSuffix(string(value), "\n"), "\r")
	}
	if secret == "" {
		return usageError("missing required secret: pass --secret or --secret-stdin")
	}
	client, err := mutationClientFromFlags(cmd, flags)
	if err != nil {
		return err
	}
	resp, err := client.post("/providers/"+args[0]+"/rotate", map[string]any{"secret": secret})
	if err != nil {
		return err
	}
	return renderAPIResult(cmd, "provider.rotate-secret", resp)
}

func providerSecret(cmd *cobra.Command, flags map[string]string) (string, error) {
	sources := 0
	if flags["secret"] != "" {
		sources++
	}
	if cmd.Flags().Changed("secret-stdin") {
		sources++
	}
	if flags["secret-env"] != "" {
		sources++
	}
	if flags["secret-file"] != "" {
		sources++
	}
	if sources != 1 {
		return "", usageError("pass exactly one of --secret, --secret-stdin, --secret-env, or --secret-file")
	}
	if flags["secret"] != "" {
		return flags["secret"], nil
	}
	if cmd.Flags().Changed("secret-stdin") {
		value, err := io.ReadAll(cmd.InOrStdin())
		return strings.TrimSuffix(strings.TrimSuffix(string(value), "\n"), "\r"), err
	}
	if name := flags["secret-env"]; name != "" {
		if value := os.Getenv(name); value != "" {
			return value, nil
		}
		return "", usageError("environment variable %s is empty", name)
	}
	value, err := os.ReadFile(flags["secret-file"])
	if err != nil {
		return "", &CLIError{Code: ExitUsage, ErrCode: "CLI_SECRET_FILE_READ_FAILED", Message: fmt.Sprintf("could not read secret file: %v", err)}
	}
	return strings.TrimSuffix(strings.TrimSuffix(string(value), "\n"), "\r"), nil
}

func providerRevokeSpecial(cmd *cobra.Command, args []string, flags map[string]string) error {
	if err := confirmDestructive(cmd, args[0], "provider revoke"); err != nil {
		return err
	}
	client, err := mutationClientFromFlags(cmd, flags)
	if err != nil {
		return err
	}
	resp, err := client.post("/providers/"+args[0]+"/revoke", nil)
	if err != nil {
		return err
	}
	return renderAPIResult(cmd, "provider.revoke", resp)
}

func confirmDestructive(cmd *cobra.Command, target, action string) error {
	if flagYes {
		return nil
	}
	if flagNoInput {
		return usageError("%s requires --yes when --no-input is set", action)
	}
	fmt.Fprintf(cmd.ErrOrStderr(), "Type %q to confirm %s: ", target, action)
	confirmed, err := bufio.NewReader(cmd.InOrStdin()).ReadString('\n')
	if err != nil && len(confirmed) == 0 {
		return usageError("%s cancelled; re-run with --yes or type %q to confirm", action, target)
	}
	if strings.TrimSpace(confirmed) != target {
		return usageError("%s cancelled; confirmation did not match %q", action, target)
	}
	return nil
}
