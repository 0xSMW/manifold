// Command manifold is the CLI for the Manifold AI gateway control plane
// (SPEC.md §12). See internal/cli for the command tree.
package main

import "github.com/0xsmw/manifold/cli/internal/cli"

func main() {
	cli.Execute()
}
