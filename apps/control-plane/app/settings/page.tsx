import { ConsoleGate } from "@/components/console/console-gate";
import { SettingsConsole } from "@/components/settings/settings-console";

export default function SettingsPage() {
  return <ConsoleGate minRole="admin"><SettingsConsole /></ConsoleGate>;
}
