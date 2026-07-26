import { ConsoleGate } from "@/components/console/console-gate";
import { UsageConsole } from "@/components/usage/usage-console";

export default function UsagePage() {
  return (
    <ConsoleGate minRole="viewer">
      <UsageConsole />
    </ConsoleGate>
  );
}
