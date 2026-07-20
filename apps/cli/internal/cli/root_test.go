package cli

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/spf13/cobra"
)

// TestRootCommandBuilds is a smoke test: the whole command tree must
// construct without panicking, and every leaf must support --help with
// exit 0 (verified separately end-to-end by scripts/walk_help.sh; this is
// the fast in-process version for `go test`/CI).
func TestRootCommandBuilds(t *testing.T) {
	root := newRootCmd()
	if root.Name() != "manifold" {
		t.Fatalf("root command name = %q, want manifold", root.Name())
	}
	if len(root.Commands()) == 0 {
		t.Fatal("root command has no subcommands")
	}
}

func TestExitCodeConstants(t *testing.T) {
	cases := map[string]int{
		"ExitOK":           ExitOK,
		"ExitGeneric":      ExitGeneric,
		"ExitUsage":        ExitUsage,
		"ExitAuth":         ExitAuth,
		"ExitNotFound":     ExitNotFound,
		"ExitPrecondition": ExitPrecondition,
	}
	want := map[string]int{
		"ExitOK": 0, "ExitGeneric": 1, "ExitUsage": 2,
		"ExitAuth": 3, "ExitNotFound": 4, "ExitPrecondition": 5,
	}
	for name, got := range cases {
		if got != want[name] {
			t.Errorf("%s = %d, want %d (SPEC.md §12.4)", name, got, want[name])
		}
	}
}

// TestHelpEveryLeaf walks the full command tree in-process and asserts
// `<path> --help` always returns a nil error (cobra help never fails).
func TestHelpEveryLeaf(t *testing.T) {
	visited := 0
	visit := func(args []string) {
		buf := new(bytes.Buffer)
		r := newRootCmd()
		r.SetOut(buf)
		r.SetErr(buf)
		r.SetArgs(append(append([]string{}, args...), "--help"))
		if err := r.Execute(); err != nil {
			t.Errorf("manifold %v --help returned error: %v", args, err)
		}
		visited++
	}

	var collect func(cmd *cobra.Command, prefix []string)
	collect = func(cmd *cobra.Command, prefix []string) {
		visit(prefix)
		for _, sub := range cmd.Commands() {
			name := sub.Name()
			if name == "help" || name == "completion" {
				continue
			}
			collect(sub, append(append([]string{}, prefix...), name))
		}
	}
	collect(newRootCmd(), nil)

	if visited == 0 {
		t.Fatal("walked zero commands")
	}
}

func TestSessionRoundTrip(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("MANIFOLD_CONFIG_DIR", dir)

	if _, err := loadSession("test-ctx"); err == nil {
		t.Fatal("expected error loading a session that was never saved")
	}

	s := session{Context: "test-ctx", Workspace: "ws_1", Principal: "p@x", Scopes: []string{"a"}}
	if err := saveSession(s); err != nil {
		t.Fatalf("saveSession: %v", err)
	}
	got, err := loadSession("test-ctx")
	if err != nil {
		t.Fatalf("loadSession: %v", err)
	}
	if got.Principal != s.Principal || got.Workspace != s.Workspace {
		t.Fatalf("round-tripped session mismatch: got %+v, want %+v", got, s)
	}

	if err := clearSession("test-ctx"); err != nil {
		t.Fatalf("clearSession: %v", err)
	}
	if _, err := loadSession("test-ctx"); err == nil {
		t.Fatal("expected error loading a session after clearSession")
	}

	// clearSession on an already-absent session must be a no-op, not an error.
	if err := clearSession("never-existed"); err != nil {
		t.Fatalf("clearSession on absent session: %v", err)
	}

	if _, err := os.Stat(filepath.Join(dir)); err != nil {
		t.Fatalf("config dir missing: %v", err)
	}
}

// TestSessionPathNoTraversal proves a malicious --context value cannot make
// sessionPath resolve outside the config directory. Path separators, "..",
// and absolute paths must all be neutralized so the session file always lands
// as a direct child of configDir() (guarding the path-traversal report where
// `manifold login --context '../../.ssh/authorized_keys'` could read/write/
// remove files outside the config dir).
func TestSessionPathNoTraversal(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("MANIFOLD_CONFIG_DIR", dir)

	base, err := filepath.Abs(configDir())
	if err != nil {
		t.Fatalf("abs configDir: %v", err)
	}

	malicious := []string{
		"../../.ssh/authorized_keys",
		"../../../etc/passwd",
		"/etc/passwd",
		"..",
		"../",
		"a/../../b",
		`..\..\windows\system32`,
		"foo/bar",
		"....//....//x",
	}

	for _, name := range malicious {
		got, err := filepath.Abs(sessionPath(name))
		if err != nil {
			t.Fatalf("abs sessionPath(%q): %v", name, err)
		}

		// The resolved path must stay strictly inside the config dir...
		rel, err := filepath.Rel(base, got)
		if err != nil {
			t.Fatalf("Rel(%q, %q): %v", base, got, err)
		}
		if rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			t.Errorf("sessionPath(%q) escaped config dir: %q (rel %q)", name, got, rel)
		}

		// ...and it must be a *direct* child of the config dir (no extra
		// path segments introduced by the context value).
		if parent := filepath.Dir(got); parent != base {
			t.Errorf("sessionPath(%q) is not a direct child of config dir: parent=%q want=%q", name, parent, base)
		}
	}
}
