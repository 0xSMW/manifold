package cli

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"time"

	keyring "github.com/zalando/go-keyring"
)

const keyringService = "manifold.cli"

// session contains context metadata only. The bearer token is deliberately
// absent: it exists solely in the operating system credential store.
type session struct {
	Context    string    `json:"context"`
	Workspace  string    `json:"workspace,omitempty"`
	BaseURL    string    `json:"base_url,omitempty"`
	Principal  string    `json:"principal,omitempty"`
	Scopes     []string  `json:"scopes,omitempty"`
	IssuedAt   time.Time `json:"issued_at,omitempty"`
	KeyringRef string    `json:"keyring_ref,omitempty"`
}

type credentialStore interface {
	Set(service, account, secret string) error
	Get(service, account string) (string, error)
	Delete(service, account string) error
}

type systemCredentialStore struct{}

func (systemCredentialStore) Set(service, account, secret string) error {
	return keyring.Set(service, account, secret)
}
func (systemCredentialStore) Get(service, account string) (string, error) {
	return keyring.Get(service, account)
}
func (systemCredentialStore) Delete(service, account string) error {
	return keyring.Delete(service, account)
}

var credentials credentialStore = systemCredentialStore{}

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

func safeContextName(contextName string) string {
	if contextName == "" {
		return "default"
	}
	var b strings.Builder
	for _, r := range contextName {
		switch {
		case r >= 'A' && r <= 'Z', r >= 'a' && r <= 'z', r >= '0' && r <= '9', r == '.', r == '_', r == '-':
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
	return filepath.Join(configDir(), "context-"+safeContextName(contextName)+".json")
}
func keyringAccount(contextName string) string { return "context:" + safeContextName(contextName) }

func saveSession(s session) error {
	if s.Context == "" {
		s.Context = "default"
	}
	if s.KeyringRef == "" {
		s.KeyringRef = keyringAccount(s.Context)
	}
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
	if s.Context == "" {
		s.Context = safeContextName(contextName)
	}
	if s.KeyringRef == "" {
		s.KeyringRef = keyringAccount(s.Context)
	}
	return &s, nil
}

func clearSession(contextName string) error {
	s, err := loadSession(contextName)
	if err == nil {
		if err := credentials.Delete(keyringService, s.KeyringRef); err != nil && !errors.Is(err, keyring.ErrNotFound) {
			return err
		}
	}
	err = os.Remove(sessionPath(contextName))
	if os.IsNotExist(err) {
		return nil
	}
	return err
}

func tokenForContext(contextName string) (string, error) {
	s, err := loadSession(contextName)
	if err != nil {
		return "", err
	}
	token, err := credentials.Get(keyringService, s.KeyringRef)
	if err != nil {
		return "", err
	}
	if strings.TrimSpace(token) == "" {
		return "", errors.New("empty credential in keyring")
	}
	return token, nil
}
