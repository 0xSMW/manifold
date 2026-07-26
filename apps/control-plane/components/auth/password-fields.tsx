import { Input } from "@/components/ui/field";

export function PasswordFields({ password, confirmation, onPassword, onConfirmation, confirmationLabel = "Confirm password", required = true }: { password: string; confirmation?: string; onPassword: (value: string) => void; onConfirmation?: (value: string) => void; confirmationLabel?: string; required?: boolean }) {
  return <><label className="console-field"><span>Password</span><Input autoComplete="new-password" minLength={12} onChange={(event) => onPassword(event.target.value)} required={required} type="password" value={password} /></label>{onConfirmation ? <label className="console-field"><span>{confirmationLabel}</span><Input autoComplete="new-password" minLength={12} onChange={(event) => onConfirmation(event.target.value)} required={required} type="password" value={confirmation ?? ""} /></label> : null}</>;
}
