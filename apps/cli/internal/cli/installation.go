package cli

import "github.com/spf13/cobra"

func newInstallationCmd() *cobra.Command {
	c := branch("installation", "manage gateway installations")
	c.AddCommand(
		buildLeaf(cmdSpec{Use: "list", Short: "list installations", Args: cobra.NoArgs, Kind: "installation.list"}),
		buildLeaf(cmdSpec{Use: "get <id>", Short: "get an installation", Args: cobra.ExactArgs(1), Kind: "installation.get"}),
		buildLeaf(cmdSpec{
			Use:   "register",
			Short: "register a new gateway installation",
			Args:  cobra.NoArgs,
			Flags: []flagSpec{
				{Name: "name", Required: true, Usage: "installation display name"},
				{Name: "public-key", Usage: "installation-identity public key (SPEC.md ADR-0024)"},
			},
			Kind: "installation.register",
		}),
		buildLeaf(cmdSpec{Use: "heartbeat <id>", Short: "record a liveness heartbeat", Args: cobra.ExactArgs(1), Kind: "installation.heartbeat"}),
		buildLeaf(cmdSpec{Use: "disable <id>", Short: "disable an installation", Args: cobra.ExactArgs(1), Kind: "installation.disable"}),
		buildLeaf(cmdSpec{
			Use:   "health",
			Short: "GET {base-url}/api/v1/health (real HTTP call if --base-url is set)",
			Args:  cobra.NoArgs,
			Flags: []flagSpec{
				{Name: "base-url", Usage: "override the global --base-url for this call"},
			},
			Kind:    "installation.health",
			Special: pingBaseURL,
		}),
	)
	return c
}

func newProfileCmd() *cobra.Command {
	c := branch("profile", "ingress profiles (public_app | enterprise_egress)")
	c.AddCommand(
		buildLeaf(cmdSpec{Use: "list", Short: "list ingress profiles", Args: cobra.NoArgs, Kind: "profile.list"}),
		buildLeaf(cmdSpec{Use: "get <id>", Short: "get an ingress profile", Args: cobra.ExactArgs(1), Kind: "profile.get"}),
		buildLeaf(cmdSpec{
			Use:   "create",
			Short: "bind a hostname + mode + auth to a new ingress profile",
			Args:  cobra.NoArgs,
			Flags: []flagSpec{
				{Name: "hostname", Required: true, Usage: "trusted hostname (ADR-0001)"},
				{Name: "mode", Required: true, Usage: "public_app | enterprise_egress"},
			},
			Kind: "profile.create",
		}),
		buildLeaf(cmdSpec{Use: "disable <id>", Short: "disable an ingress profile", Args: cobra.ExactArgs(1), Kind: "profile.disable"}),
	)
	return c
}
