package cli

import "fmt"

// Exit codes, per SPEC.md §12 (simplified skeleton subset):
//
//	0 success
//	1 generic / unexpected error
//	2 usage / validation error (bad flags, bad args, missing required input)
//	3 auth error (not logged in, expired/invalid token, missing scope)
//	4 not found
//	5 precondition failed / conflict (e.g. CONFIG_PRECONDITION_FAILED)
const (
	ExitOK           = 0
	ExitGeneric      = 1
	ExitUsage        = 2
	ExitAuth         = 3
	ExitNotFound     = 4
	ExitPrecondition = 5
)

// CLIError is the structured, agent-safe error the CLI prints per SPEC.md
// §0.3 / §12.9. Every non-zero exit from a command handler should produce
// one of these so scripts and agents can branch on Code and ErrCode.
type CLIError struct {
	Code        int    // process exit code (0-5, see constants above)
	ErrCode     string // reason code, e.g. AUTH_KEY_UNKNOWN, CONFIG_PRECONDITION_FAILED
	Message     string
	Remediation string
	Retryable   bool
	Details     map[string]string
}

func (e *CLIError) Error() string {
	return fmt.Sprintf("%s: %s", e.ErrCode, e.Message)
}

func usageError(format string, a ...any) *CLIError {
	return &CLIError{
		Code:        ExitUsage,
		ErrCode:     "CLI_USAGE_ERROR",
		Message:     fmt.Sprintf(format, a...),
		Remediation: "check `--help` for this command for the expected flags and arguments",
	}
}

func authError(message, remediation string) *CLIError {
	return &CLIError{
		Code:        ExitAuth,
		ErrCode:     "AUTH_NOT_LOGGED_IN",
		Message:     message,
		Remediation: remediation,
		Retryable:   false,
	}
}

func notFoundError(kind, id string) *CLIError {
	return &CLIError{
		Code:        ExitNotFound,
		ErrCode:     "RESOURCE_NOT_FOUND",
		Message:     fmt.Sprintf("%s %q not found", kind, id),
		Remediation: fmt.Sprintf("run `manifold %s list` to see valid ids", kind),
		Retryable:   false,
	}
}

func preconditionError(message, remediation string, details map[string]string) *CLIError {
	return &CLIError{
		Code:        ExitPrecondition,
		ErrCode:     "CONFIG_PRECONDITION_FAILED",
		Message:     message,
		Remediation: remediation,
		Retryable:   true,
		Details:     details,
	}
}
