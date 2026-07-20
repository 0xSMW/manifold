package cli

import (
	"github.com/spf13/cobra"
)

// flagSpec describes one string flag a stub leaf command accepts. Every
// stub flag is a string (the handlers do not act on values yet, they just
// echo what was parsed), which keeps the whole command tree declarative.
type flagSpec struct {
	Name      string
	Shorthand string
	Default   string
	Usage     string
	Required  bool
}

// specialFunc lets a small number of leaf commands override the generic
// "parse and echo a stub" behavior, e.g. to demonstrate a real exit code
// (auth, not-found, precondition) or to make a real HTTP call
// (installation health).
type specialFunc func(cmd *cobra.Command, args []string, flags map[string]string) error

// cmdSpec is the declarative description of one leaf (or branch-with-own-
// verb) command in the tree.
type cmdSpec struct {
	Use     string
	Short   string
	Long    string
	Aliases []string
	Args    cobra.PositionalArgs
	Flags   []flagSpec
	Kind    string
	Special specialFunc
}

// buildLeaf turns a cmdSpec into a runnable *cobra.Command.
func buildLeaf(spec cmdSpec) *cobra.Command {
	c := &cobra.Command{
		Use:     spec.Use,
		Short:   spec.Short,
		Long:    spec.Long,
		Aliases: spec.Aliases,
		Args:    spec.Args,
	}
	for _, f := range spec.Flags {
		c.Flags().StringP(f.Name, f.Shorthand, f.Default, f.Usage)
	}
	requiredFlags := spec.Flags
	kind := spec.Kind
	special := spec.Special
	c.RunE = func(cmd *cobra.Command, args []string) error {
		for _, f := range requiredFlags {
			if !f.Required {
				continue
			}
			v, _ := flagString(cmd, f.Name)
			if v == "" {
				return usageError("missing required flag --%s", f.Name)
			}
		}
		flagsOut := collectFlags(cmd, requiredFlags)
		if special != nil {
			return special(cmd, args, flagsOut)
		}
		return printStub(cmd, kind, args, flagsOut)
	}
	return c
}

// collectFlags reads back every declared flag (skipping ones left at their
// zero-value default so stub output isn't noisy) into a map for echoing.
func collectFlags(cmd *cobra.Command, specs []flagSpec) map[string]string {
	out := map[string]string{}
	for _, f := range specs {
		if !cmd.Flags().Changed(f.Name) {
			continue
		}
		v, _ := flagString(cmd, f.Name)
		out[f.Name] = v
	}
	return out
}

// leafList builds the conventional "<noun> list" leaf: no positional args,
// Kind "<noun>.list". Only the human-facing Short varies between nouns, so it
// is the single caller-supplied field; everything else follows convention.
func leafList(noun, short string) *cobra.Command {
	return buildLeaf(cmdSpec{Use: "list", Short: short, Args: cobra.NoArgs, Kind: noun + ".list"})
}

// leafGet builds the conventional "<noun> get <id>" leaf: exactly one id arg,
// Kind "<noun>.get".
func leafGet(noun, short string) *cobra.Command {
	return buildLeaf(cmdSpec{Use: "get <id>", Short: short, Args: cobra.ExactArgs(1), Kind: noun + ".get"})
}

// branch makes a parent noun command that only groups subcommands (e.g.
// `manifold provider`, `manifold provider revision`) — running it bare
// prints help rather than a stub, matching cobra convention for group
// commands.
func branch(use, short string) *cobra.Command {
	return &cobra.Command{
		Use:   use,
		Short: short,
	}
}
