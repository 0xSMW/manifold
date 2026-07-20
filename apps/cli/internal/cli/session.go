package cli

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// session is the skeleton's stand-in for the OS-keyring-backed token from
// SPEC.md §12.5. It is NOT the real device-auth flow — it is a small local
// marker file so `login` / `whoami` / `logout` demonstrate a real state
// transition (and a real exit-3 auth error when logged out) without wiring
// an actual control-plane or OS keyring integration.
type session struct {
	Context   string    `json:"context"`
	Workspace string    `json:"workspace"`
	Principal string    `json:"principal"`
	Scopes    []string  `json:"scopes"`
	IssuedAt  time.Time `json:"issued_at"`
}

func configDir() string {
	if v := os.Getenv("MANIFOLD_CONFIG_DIR"); v != "" {
		return v
	}
	base, err := os.UserConfigDir()
	if err != nil || base == "" {
		base = os.TempDir()
	}
	return filepath.Join(base, "manifold")
}

// safeContextName reduces an arbitrary, attacker-controlled --context value to
// a single, harmless path component. Only [A-Za-z0-9._-] survive; every other
// byte (crucially the path separators '/' and '\') is replaced with '_', so the
// result can never introduce a new path segment. A value that would still be a
// traversal component on its own ("", ".", "..") falls back to "default". This
// guarantees sessionPath() always resolves to a direct child of configDir(),
// even for inputs like "../../.ssh/authorized_keys" or "/etc/passwd".
func safeContextName(contextName string) string {
	if contextName == "" {
		return "default"
	}
	var b strings.Builder
	for _, r := range contextName {
		switch {
		case r >= 'A' && r <= 'Z',
			r >= 'a' && r <= 'z',
			r >= '0' && r <= '9',
			r == '.', r == '_', r == '-':
			b.WriteRune(r)
		default:
			b.WriteByte('_')
		}
	}
	name := b.String()
	if name == "" || name == "." || name == ".." {
		return "default"
	}
	return name
}

func sessionPath(contextName string) string {
	return filepath.Join(configDir(), "session-"+safeContextName(contextName)+".json")
}

func saveSession(s session) error {
	if err := os.MkdirAll(configDir(), 0o700); err != nil {
		return err
	}
	b, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(sessionPath(s.Context), b, 0o600)
}

func loadSession(contextName string) (*session, error) {
	b, err := os.ReadFile(sessionPath(contextName))
	if err != nil {
		return nil, err
	}
	var s session
	if err := json.Unmarshal(b, &s); err != nil {
		return nil, err
	}
	return &s, nil
}

func clearSession(contextName string) error {
	err := os.Remove(sessionPath(contextName))
	if os.IsNotExist(err) {
		return nil
	}
	return err
}
